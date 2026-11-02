"""Guard distinct Main Dashboard, Device, and Wallboard navigation routes."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    dashboard = (ROOT / "web" / "dashboard.html").read_text(encoding="utf-8")
    mission = (ROOT / "web" / "mission.js").read_text(encoding="utf-8")
    device_page = (ROOT / "web" / "device.html").read_text(encoding="utf-8")
    device = (ROOT / "web" / "device.js").read_text(encoding="utf-8")
    wallboard = (ROOT / "web" / "wallboard.html").read_text(encoding="utf-8")
    wall_controller = (ROOT / "web" / "wallboard.js").read_text(encoding="utf-8")
    wall_styles = (ROOT / "web" / "wallboard.css").read_text(encoding="utf-8")
    server = (ROOT / "app.c").read_text(encoding="utf-8")
    command_center = (ROOT / "web" / "telemetry-tools.html").read_text(encoding="utf-8")
    sidebar_pages = (
        "history.html", "device.html", "hmi.html", "diagnostic.html",
        "topology.html", "telemetry-tools.html",
    )

    require('href="wallboard.html"' in dashboard, "Main Dashboard lacks a Wallboard route")
    require("MAIN DASHBOARD" in dashboard, "dashboard.html does not contain the Main Dashboard")
    require("Fleet Wallboard" in wallboard, "wallboard.html does not contain the Wallboard")
    require("Telemetry Tools" in command_center, "telemetry-tools.html does not contain Telemetry Tools")
    require('src="mission.js' in dashboard and 'src="wallboard.js' not in dashboard,
            "dashboard.html loads the wrong page controller")
    require('src="wallboard.js' in wallboard and 'src="mission.js' not in wallboard,
            "wallboard.html loads the wrong page controller")
    require('src="dashboard.js' in command_center and 'src="wallboard.js' not in command_center,
            "telemetry-tools.html loads the wrong page controller")
    require('Location: /dashboard.html\\r\\n' in server,
            "The server default route does not open the Main Dashboard")
    for page in sidebar_pages:
        html = (ROOT / "web" / page).read_text(encoding="utf-8")
        require('href="dashboard.html"' in html,
                f"{page} Main Dashboard navigation does not open dashboard.html")
        require('href="wallboard.html"' in html,
                f"{page} Wallboard navigation does not open wallboard.html")
    require('href="dashboard.html"' in dashboard,
            "Dashboard brand icon does not open the Main Dashboard")
    require('href="dashboard.html"' in wallboard and "wall-home" in wallboard,
            "Wallboard Main Dashboard or icon navigation does not open dashboard.html")
    require('id="detailPane"' not in dashboard and 'id="splitter"' not in dashboard,
            "Main Dashboard still contains Wallboard-style split details")
    require('location.assign(missionDeviceUrl(name))' in mission,
            "Main Dashboard device action does not navigate to a full page")
    require('new URL("device.html", location.href)' in mission and
            'url.searchParams.set("name"' in mission and
            'url.searchParams.set("db"' in mission,
            "Main Dashboard device route is missing device or database context")
    require('location.replace(missionDeviceUrl(detail))' in mission,
            "Legacy detail links do not resolve to a standalone device page")
    require('location.replace(fleetUrl.href)' not in device_page,
            "Standalone Device Page redirects back to the fleet dashboard")
    require('deviceRoute.get("embed") === "1"' in device_page,
            "Device Page embed styling is not restricted to explicit embeds")
    require('deviceLiveDb = $("dbSelect").value;' in device and
            device.index('deviceLiveDb = $("dbSelect").value;') <
            device.index('if (DB_FROM_URL)'),
            "Device Page must keep live messages on the newest shard, separate from a selected history shard")
    require('url.searchParams.set("db", db)' in device,
            "Device Page return navigation does not preserve its selected database")
    require('embed=1&name=${encodeURIComponent(device)}' in wall_controller,
            "Wallboard inspection does not use the embedded Device Page route")
    require('Inspect in split view' in wallboard or 'Inspect in split view' in wall_controller,
            "Wallboard has no split-view device inspection action")
    require('.fleet-pane, .detail-pane { min-width: 0; overflow: auto;' in wall_styles,
            "Wallboard fleet and detail panels do not scroll independently")

    print("Navigation route checks passed: full-page Main Dashboard devices and isolated Wallboard split view.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
