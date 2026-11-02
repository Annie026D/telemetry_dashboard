/*
 * Offline Chart.js dependency fallback.
 *
 * This module provides the limited Chart.js-compatible interface required by
 * the telemetry dashboard when the external Chart.js CDN cannot be reached.
 *
 * It renders line charts directly on an HTML canvas, makes no network
 * requests, and does not store data in cookies, local storage, or databases.
 */
(function () {
  /*
   * Stop immediately when the full Chart.js library is already available.
   * This prevents the fallback implementation from replacing the real library.
   */
  if (window.Chart) {
    return;
  }

  /**
   * Returns a consistent fallback colour for a dataset.
   *
   * @param {number} index - Zero-based index of the dataset.
   * @returns {string} A hexadecimal CSS colour value.
   */
  function color(index) {
    /*
     * Define a fixed set of visually distinct colours for graph lines.
     * Keeping this palette constant gives each series a predictable colour.
     */
    const palette = [
      "#60a5fa", // Light blue.
      "#34d399", // Emerald green.
      "#fbbf24", // Amber.
      "#f472b6", // Pink.
      "#a78bfa", // Violet.
      "#fb7185", // Rose.
      "#22d3ee", // Cyan.
      "#f97316"  // Orange.
    ];

    /*
     * Use the remainder operator to reuse the palette safely when the number
     * of datasets is greater than the number of available colours.
     */
    return palette[index % palette.length];
  }

  /**
   * Converts a supported raw data point into a numeric x/y coordinate.
   *
   * The fallback accepts either:
   *   1. An object containing x/y, t/value, or compatible fields.
   *   2. A primitive numeric value, whose array position becomes its x value.
   *
   * @param {*} point - Raw dataset value supplied by the page controller.
   * @param {number} index - Position of the value in its dataset.
   * @returns {{x: number, y: number}} Normalized numeric coordinates.
   */
  function pointValue(point, index) {
    /*
     * Handle object-based points such as {x: timestamp, y: measurement}.
     * The additional t and value properties support alternate payload formats.
     */
    if (point && typeof point === "object") {
      return {
        /*
         * Prefer point.x, otherwise use point.t, and finally use the array
         * index. Number() converts numeric strings to numbers.
         */
        x: Number(point.x ?? point.t ?? index),

        /*
         * Prefer point.y, otherwise use point.value. Use zero when neither
         * measurement field is available.
         */
        y: Number(point.y ?? point.value ?? 0)
      };
    }

    /*
     * Primitive values do not include an explicit horizontal coordinate,
     * so their array position is used as the x value.
     */
    return {
      x: index,

      /* Convert the primitive measurement to a JavaScript number. */
      y: Number(point)
    };
  }

  /**
   * Calculates finite minimum and maximum values for a chart axis.
   *
   * @param {number[]} values - Candidate values for the axis.
   * @param {number} fallbackMin - Minimum used when no finite values exist.
   * @param {number} fallbackMax - Maximum used when no finite values exist.
   * @returns {{min: number, max: number}} Safe axis boundaries.
   */
  function finiteBounds(values, fallbackMin, fallbackMax) {
    /*
     * Remove NaN, positive infinity, and negative infinity because they cannot
     * be converted into valid canvas coordinates.
     */
    const nums = values.filter(Number.isFinite);

    /* Use the caller's safe defaults when the series contains no valid values. */
    if (!nums.length) {
      return {
        min: fallbackMin,
        max: fallbackMax
      };
    }

    /* Determine the smallest valid value available for the axis. */
    let min = Math.min(...nums);

    /* Determine the largest valid value available for the axis. */
    let max = Math.max(...nums);

    /*
     * A constant-value series has an axis range of zero. Add padding so the
     * scale remains drawable and the line is visible instead of producing a
     * division-by-zero condition.
     */
    if (min === max) {
      /*
       * Use ten percent of the value as padding, with a minimum padding of one
       * so zero and very small measurements still receive a visible range.
       */
      const pad = Math.max(Math.abs(min) * 0.1, 1);

      /* Extend the lower boundary below the constant measurement. */
      min -= pad;

      /* Extend the upper boundary above the constant measurement. */
      max += pad;
    }

    /* Return the validated and, where necessary, padded axis boundaries. */
    return {
      min,
      max
    };
  }

  /**
   * Draws one complete chart using the native Canvas 2D API.
   *
   * The function sizes the canvas for the device pixel ratio, calculates the
   * plotting area, normalizes datasets, draws horizontal grid lines and labels,
   * renders each telemetry series, and draws a compact legend.
   *
   * @param {Object} chart - Fallback chart instance to render.
   * @returns {void}
   */
  function draw(chart) {
    /* Obtain the HTML canvas associated with this chart instance. */
    const canvas = chart.canvas;

    /* Acquire the two-dimensional drawing context used for canvas rendering. */
    const ctx = canvas.getContext("2d");

    /*
     * Read the canvas's current on-screen dimensions. These dimensions can
     * change when the browser window or dashboard layout is resized.
     */
    const rect = canvas.getBoundingClientRect();

    /*
     * Use the screen's pixel-density ratio for sharp rendering on high-DPI
     * displays. Standard displays fall back to a ratio of one.
     */
    const dpr = window.devicePixelRatio || 1;

    /*
     * Determine the logical canvas width. Enforce a minimum of 320 pixels and
     * use 640 pixels when the browser cannot report a usable width.
     */
    const width = Math.max(
      320,
      Math.floor(rect.width || canvas.clientWidth || 640)
    );

    /*
     * Determine the logical canvas height. Enforce a minimum of 180 pixels and
     * use 260 pixels when the browser cannot report a usable height.
     */
    const height = Math.max(
      180,
      Math.floor(rect.height || canvas.clientHeight || 260)
    );

    /*
     * Compare the physical canvas buffer size with the size required for the
     * current logical dimensions and device pixel ratio.
     */
    const sizeChanged =
      canvas.width !== width * dpr ||
      canvas.height !== height * dpr;

    /*
     * Resize the physical drawing buffer only when necessary. Assigning width
     * or height clears the canvas and resets its drawing context.
     */
    if (sizeChanged) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    /*
     * Scale logical canvas coordinates to physical device pixels. The chart
     * can continue drawing in CSS-pixel units while remaining sharp on
     * high-resolution displays.
     */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /*
     * Rebuild the background when the canvas was resized or when this chart
     * has not yet initialized its fallback background.
     */
    if (sizeChanged || !chart._fallbackBackgroundReady) {
      /* Remove any content previously drawn inside the logical canvas area. */
      ctx.clearRect(0, 0, width, height);

      /* Select the dashboard's dark navy colour for the chart background. */
      ctx.fillStyle = "#020617";

      /* Paint the entire logical canvas with the selected background colour. */
      ctx.fillRect(0, 0, width, height);

      /* Record that the fallback background has been initialized. */
      chart._fallbackBackgroundReady = true;
    }

    /*
     * Reserve space around the plotting area for y-axis labels, headings,
     * margins, and the compact series legend.
     */
    const pad = {
      left: 44,   // Space for y-axis values.
      right: 18,  // Right-side visual margin.
      top: 22,    // Space above the graph.
      bottom: 32  // Space below the graph for timestamp labels.
    };

    /*
     * Calculate the usable horizontal plotting width. A minimum of one avoids
     * invalid or negative dimensions in unusually small containers.
     */
    const plotW = Math.max(
      1,
      width - pad.left - pad.right
    );

    /*
     * Calculate the usable vertical plotting height. A minimum of one prevents
     * invalid coordinate calculations.
     */
    const plotH = Math.max(
      1,
      height - pad.top - pad.bottom
    );

    /*
     * Read the datasets provided by the chart configuration. Use an empty
     * array when no dataset collection has been supplied.
     */
    const datasets = chart.data.datasets || [];

    /*
     * Normalize every dataset into a structure containing its configuration,
     * index, and valid numeric points.
     */
    const series = datasets.map((dataset, datasetIndex) => {
      /*
       * Read the dataset's raw data collection. Missing data is represented by
       * an empty array so the following transformation remains safe.
       */
      const raw = dataset.data || [];

      /*
       * Convert every raw point to x/y coordinates, then remove points whose
       * coordinates are NaN or infinite.
       */
      const points = raw
        .map((point, index) => pointValue(point, index))
        .filter(
          point =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y)
        );

      /*
       * Retain the dataset configuration and original index alongside the
       * validated points needed by the renderer.
       */
      return {
        dataset,
        datasetIndex,
        points
      };
    });

    /*
     * Calculate the horizontal axis limits from every valid x coordinate in
     * every series.
     */
    const calculatedXBounds = finiteBounds(
      /*
       * Flatten all series into one array containing only x coordinates.
       */
      series.flatMap(
        currentSeries =>
          currentSeries.points.map(point => point.x)
      ),

      /* Use zero as the fallback horizontal minimum. */
      0,

      /*
       * Use the label count as the fallback maximum while ensuring the range
       * remains at least one unit wide.
       */
      Math.max(
        1,
        (chart.data.labels || []).length - 1
      )
    );

    /* Honour the visible window set by the diagnostics zoom and pan controls. */
    const configuredXAxis = chart.options?.scales?.x || {};
    const xBounds = {
      min: Number.isFinite(Number(configuredXAxis.min)) ? Number(configuredXAxis.min) : calculatedXBounds.min,
      max: Number.isFinite(Number(configuredXAxis.max)) ? Number(configuredXAxis.max) : calculatedXBounds.max
    };

    /*
     * Calculate the vertical axis limits from every valid y measurement.
     */
    const yBounds = finiteBounds(
      /*
       * Flatten all series into one array containing only y coordinates.
       */
      series.flatMap(
        currentSeries =>
          currentSeries.points.map(point => point.y)
      ),

      /* Default to -1 when no valid y values exist. */
      -1,

      /* Default to 1 to provide a visible two-unit fallback range. */
      1
    );

    /* Select a subtle semi-transparent colour for horizontal grid lines. */
    ctx.strokeStyle = "rgba(148,163,184,.18)";

    /* Draw grid lines one logical pixel wide. */
    ctx.lineWidth = 1;

    /* Begin one path containing all horizontal grid-line segments. */
    ctx.beginPath();

    /*
     * Create five evenly spaced horizontal grid lines, including the upper and
     * lower boundaries of the plotting area.
     */
    for (let i = 0; i <= 4; i++) {
      /* Calculate the vertical position of the current grid line. */
      const y = pad.top + (plotH * i / 4);

      /* Move to the left edge without drawing a connecting segment. */
      ctx.moveTo(pad.left, y);

      /* Add a line from the left edge to the right edge of the plot. */
      ctx.lineTo(width - pad.right, y);
    }

    /* Draw readable timestamps across the currently visible x-axis window. */
    ctx.fillStyle = "#94a3b8";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const value = xBounds.min + (xBounds.max - xBounds.min) * i / 4;
      const x = pad.left + plotW * i / 4;
      const label = new Date(value).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      ctx.fillText(label, x, height - 20);
    }

    /* Render all grid-line segments added to the current path. */
    ctx.stroke();

    /* Select the muted dashboard colour used for axis labels. */
    ctx.fillStyle = "#94a3b8";

    /* Configure a compact system font for axis and legend text. */
    ctx.font = "11px system-ui, sans-serif";

    /* Align y-axis labels against the left side of the plotting area. */
    ctx.textAlign = "right";

    /* Vertically centre each y-axis label on its grid line. */
    ctx.textBaseline = "middle";

    /*
     * Draw one numeric y-axis label for each of the five horizontal grid lines.
     */
    for (let i = 0; i <= 4; i++) {
      /*
       * Convert the grid-line position back into its corresponding data value.
       * The upper grid line represents the maximum and the lower represents
       * the minimum.
       */
      const value =
        yBounds.max -
        ((yBounds.max - yBounds.min) * i / 4);

      /* Calculate the canvas y coordinate for the current label. */
      const y = pad.top + (plotH * i / 4);

      /*
       * Display the value with one decimal place, positioned eight pixels to
       * the left of the plotting area.
       */
      ctx.fillText(
        value.toFixed(1),
        pad.left - 8,
        y
      );
    }

    /* Render each normalized telemetry series as an independent line. */
    series.forEach(({ dataset, datasetIndex, points }) => {
      /* Skip datasets that contain no valid numeric points. */
      if (!points.length) {
        return;
      }

      /*
       * Choose the line colour using the dataset's explicit border colour,
       * then its background colour, and finally the local fallback palette.
       */
      ctx.strokeStyle =
        dataset.borderColor ||
        dataset.backgroundColor ||
        color(datasetIndex);

      /*
       * Use the configured border width when available; otherwise draw a
       * two-pixel line.
       */
      ctx.lineWidth = dataset.borderWidth || 2;

      /* Start a new path so this series does not connect to another dataset. */
      ctx.beginPath();

      /* Convert and append every telemetry point to the current canvas path. */
      let previousPoint = null;
      points.forEach((point, index) => {
        /*
         * Convert the point's x value from data-space into a horizontal canvas
         * coordinate within the plotting area.
         *
         * The `|| 1` guard prevents division by zero if an unexpected
         * zero-width range reaches this calculation.
         */
        const x =
          pad.left +
          (
            (point.x - xBounds.min) /
            (xBounds.max - xBounds.min || 1)
          ) *
          plotW;

        /*
         * Convert the point's y value from data-space into a canvas coordinate.
         * Canvas y coordinates increase downward, so the normalized value is
         * inverted using `1 - normalizedValue`.
         */
        const y =
          pad.top +
          (
            1 -
            (
              (point.y - yBounds.min) /
              (yBounds.max - yBounds.min || 1)
            )
          ) *
          plotH;

        /*
         * Position the drawing cursor at the first point without drawing an
         * unwanted line from the canvas origin.
         */
        const outsideWindow = point.x < xBounds.min || point.x > xBounds.max;
        const followsGap = previousPoint && Number(dataset.gapThreshold) > 0 && point.x - previousPoint.x > Number(dataset.gapThreshold);
        if (index === 0 || followsGap || outsideWindow || (previousPoint && previousPoint.x < xBounds.min)) {
          ctx.moveTo(x, y);
        } else {
          /* Connect subsequent points to the preceding point. */
          ctx.lineTo(x, y);
        }
        previousPoint = point;
      });

      /* Draw the completed path for the current telemetry series. */
      ctx.stroke();
    });

    /* Left-align the series labels used in the compact legend. */
    ctx.textAlign = "left";

    /* Align legend text from its upper edge. */
    ctx.textBaseline = "top";

    /*
     * Display at most six dataset labels to prevent the fallback legend from
     * overcrowding the limited canvas area.
     */
    [].forEach((dataset, index) => {
      /*
       * Arrange legend entries in three columns. The remainder determines the
       * column position for the current entry.
       */
      const x =
        pad.left +
        (index % 3) * 150;

      /*
       * Arrange entries after the first three on a second row. Math.floor()
       * converts the dataset index into a zero-based row number.
       */
      const y =
        height -
        22 +
        Math.floor(index / 3) * 14;

      /*
       * Use the same colour-selection order for the legend marker as for its
       * corresponding graph line.
       */
      ctx.fillStyle =
        dataset.borderColor ||
        dataset.backgroundColor ||
        color(index);

      /* Draw a short horizontal colour marker for the legend entry. */
      ctx.fillRect(x, y + 3, 18, 3);

      /* Select the light text colour used for legend labels. */
      ctx.fillStyle = "#cbd5e1";

      /*
       * Draw the dataset label beside its colour marker. Use "Series" when the
       * dataset does not provide a label.
       */
      ctx.fillText(
        String(dataset.label || "Series"),
        x + 24,
        y
      );
    });
  }

  /**
   * Creates a minimal Chart.js-compatible chart instance.
   *
   * The constructor exposes the canvas, context, configuration, data, options,
   * update(), and destroy() members used by the telemetry dashboard.
   *
   * @param {HTMLCanvasElement|Object} canvas - Canvas element or wrapper
   *        containing a canvas property.
   * @param {Object} config - Chart configuration containing data and options.
   * @returns {Chart} A fallback chart instance.
   */
  window.Chart = function Chart(canvas, config) {
    /*
     * Support calls made without the `new` keyword by creating and returning a
     * correctly initialized Chart instance.
     */
    if (!(this instanceof Chart)) {
      return new Chart(canvas, config);
    }

    /*
     * Accept either a direct canvas element or a wrapper exposing the canvas
     * through its `canvas` property.
     */
    this.canvas =
      canvas && canvas.canvas
        ? canvas.canvas
        : canvas;

    /* Store the canvas's two-dimensional drawing context. */
    this.ctx = this.canvas.getContext("2d");

    /* Store the supplied configuration or create an empty configuration. */
    this.config = config || {};

    /*
     * Expose chart data using the Chart.js-compatible property name. Create an
     * empty dataset collection when no data configuration is supplied.
     */
    this.data =
      this.config.data ||
      {
        datasets: []
      };

    /*
     * Expose chart options for compatibility, even though this lightweight
     * renderer supports only the options it reads directly.
     */
    this.options = this.config.options || {};

    /* Track whether destroy() has permanently disabled this chart instance. */
    this.destroyed = false;

    /*
     * Track whether the fallback background has been painted since the most
     * recent canvas resize.
     */
    this._fallbackBackgroundReady = false;

    /*
     * Track whether a render request is already waiting for the next animation
     * frame. This prevents repeated updates from scheduling duplicate draws.
     */
    this._fallbackPending = false;

    /**
     * Requests an asynchronous chart redraw.
     *
     * Multiple update calls made during the same browser frame are combined
     * into one draw operation, which reduces rendering pressure during rapid
     * live telemetry updates.
     *
     * @returns {void}
     */
    this.update = () => {
      /* Ignore updates after the chart has been destroyed. */
      if (this.destroyed) {
        return;
      }

      /*
       * Do not schedule another frame when a previous update is already
       * waiting to be rendered.
       */
      if (this._fallbackPending) {
        return;
      }

      /* Mark the chart as having a pending animation-frame callback. */
      this._fallbackPending = true;

      /*
       * Schedule rendering immediately before the browser's next screen paint
       * for smoother and more efficient live updates.
       */
      window.requestAnimationFrame(() => {
        /*
         * Clear the pending flag so a later update can schedule another frame.
         */
        this._fallbackPending = false;

        /*
         * Recheck the destroyed state because destroy() may have been called
         * after the frame was scheduled but before this callback executed.
         */
        if (!this.destroyed) {
          draw(this);
        }
      });
    };

    /**
     * Permanently disables further rendering for this chart instance.
     *
     * @returns {void}
     */
    this.destroy = () => {
      /* Prevent all future update and rendering operations. */
      this.destroyed = true;

      /*
       * Clear the scheduling flag. A callback already queued by the browser
       * cannot be cancelled here, but it will observe the destroyed state and
       * skip drawing.
       */
      this._fallbackPending = false;
    };

    /*
     * Schedule the initial rendering immediately after instance setup is
     * complete.
     */
    this.update();
  };

  /*
   * Mark the installed Chart constructor as the local fallback. Diagnostic or
   * page code can inspect this flag to distinguish it from full Chart.js.
   */
  window.Chart.__localFallback = true;
})();
