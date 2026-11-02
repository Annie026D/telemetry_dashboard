"""Generate a reviewed C include/catalog from captured representative JSON logs."""
import collections, glob, json, pathlib, re
ROOT=pathlib.Path(__file__).resolve().parents[1]
def flatten(value,prefix="",out=None):
    out={} if out is None else out
    if isinstance(value,dict):
        for key,child in value.items(): flatten(child,f"{prefix}_{key}" if prefix else str(key),out)
    elif isinstance(value,list):
        for index,child in enumerate(value): flatten(child,f"{prefix}_{index}",out)
    elif prefix:
        key=re.sub(r"[^A-Za-z0-9_]","_",prefix)[:119]
        out[key]="REAL" if isinstance(value,(int,float,bool)) else "TEXT"
    return out
def main():
    catalog=collections.defaultdict(dict)
    counts=collections.Counter()
    for name in glob.glob(str(ROOT/"logs"/"udp_packets_*.jsonl")):
        with open(name,encoding="utf-8",errors="ignore") as source:
            for line in source:
                try: packet=json.loads(line)
                except json.JSONDecodeError: continue
                device=str(packet.get("device") or "UNKNOWN_DEVICE").upper()
                for key,kind in flatten(packet.get("payload") or {}).items():
                    previous=catalog[device].get(key)
                    catalog[device][key]="TEXT" if "TEXT" in (previous,kind) else "REAL"
                counts[device]+=1
    union={key:kind for fields in catalog.values() for key,kind in fields.items()}
    report={"packets":counts,"devices":{d:{"field_count":len(v),"fields":v} for d,v in sorted(catalog.items())},"union_fields":len(union)}
    (ROOT/"observed_telemetry_schema.json").write_text(json.dumps(report,indent=2,default=dict),encoding="utf-8")
    reserved={"id","session_id","timestamp","server_rx_ts","device_ts","packet_ts","latency_ms","device_name","channel_name","source_ip","source_port","subdevice_name","process_name","subprocess_name","anomaly","reason","raw_json"}
    lines=["/* Generated from captured representative telemetry; do not hand edit. */"]
    for device,fields in sorted(catalog.items()):
        seen=set()
        for field,kind in sorted(fields.items(),key=lambda item:item[0].lower()):
            folded=field.lower()
            if folded in reserved or folded in seen: continue
            seen.add(folded)
            lines.append(f'{{"{device}","{field}","{kind}"}},')
    (ROOT/"observed_telemetry_columns.inc").write_text("\n".join(lines)+"\n",encoding="ascii")
    print(json.dumps({"packets":counts,"field_counts":{d:len(v) for d,v in catalog.items()},"union_fields":len(union)},default=dict,indent=2))
if __name__=="__main__":main()
