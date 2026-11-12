import hashlib
import json
import sys
from collections import OrderedDict
from datetime import datetime, timezone

import openpyxl


def clean(value):
    return "" if value is None else str(value).strip()


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: extract-ranchers-freight-workbook.py <input.xlsx> <output.json>")
    input_path, output_path = sys.argv[1], sys.argv[2]
    with open(input_path, "rb") as source_file:
        source_bytes = source_file.read()
    workbook = openpyxl.load_workbook(input_path, read_only=True, data_only=True)
    worksheet = workbook["Ranchers Charges"]
    rows = worksheet.iter_rows(values_only=True)
    headers = [clean(value) for value in next(rows)]
    column = {name: index for index, name in enumerate(headers)}
    required = ["Order Number", "Package", "Carrier", "Tracking Number"]
    missing = [name for name in required if name not in column]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")

    orders = OrderedDict()
    tracking_owners = {}
    duplicate_tracking = []
    blank_tracking_rows = []
    for sheet_row, values in enumerate(rows, start=2):
        order_code = clean(values[column["Order Number"]]).upper()
        if not order_code:
            continue
        carrier = clean(values[column["Carrier"]])
        tracking = clean(values[column["Tracking Number"]]).upper().replace(" ", "")
        package = clean(values[column["Package"]])
        if not tracking:
            blank_tracking_rows.append(sheet_row)
        elif tracking in tracking_owners and tracking_owners[tracking] != order_code:
            duplicate_tracking.append({
                "tracking": tracking,
                "firstOrder": tracking_owners[tracking],
                "secondOrder": order_code,
                "sheetRow": sheet_row,
            })
        else:
            tracking_owners[tracking] = order_code
        entry = orders.setdefault(order_code, {
            "orderCode": order_code,
            "poNumber": clean(values[column.get("PO Number", -1)]) if "PO Number" in column else "",
            "packages": [],
        })
        entry["packages"].append({
            "package": package,
            "carrier": carrier,
            "service": clean(values[column.get("Service", -1)]) if "Service" in column else "",
            "tracking": tracking,
            "sheetRow": sheet_row,
        })

    for entry in orders.values():
        entry["carriers"] = list(dict.fromkeys(
            package["carrier"] for package in entry["packages"] if package["carrier"]
        ))
        entry["trackingNumbers"] = list(dict.fromkeys(
            package["tracking"] for package in entry["packages"] if package["tracking"]
        ))
        entry["packageCount"] = len(entry["packages"])

    output = {
        "source": {
            "path": input_path,
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
            "sheet": "Ranchers Charges",
        },
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "packageRows": sum(entry["packageCount"] for entry in orders.values()),
        "orderCount": len(orders),
        "blankTrackingRows": blank_tracking_rows,
        "duplicateTrackingAcrossOrders": duplicate_tracking,
        "orders": list(orders.values()),
    }
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(output, output_file, indent=2)


if __name__ == "__main__":
    main()
