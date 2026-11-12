from datetime import datetime, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).resolve().parents[1] / "output" / "pdf" / "WMS365_BOL_ORD-001339_PRE_SHIPMENT.pdf"
PALLETS = [(1, "DI20AA", 2312), (2, "DI22AA", 2309), (3, "DI24AA", 2309), (4, "DI26AA", 2310)]
LB_TO_KG = 0.45359237
INK = colors.HexColor("#1C3340")
MUTED = colors.HexColor("#4E626B")
RULE = colors.HexColor("#9AADB2")


def label(c, x, y, text):
    c.setFont("Helvetica-Bold", 7)
    c.setFillColor(MUTED)
    c.drawString(x, y, text.upper())


def value(c, x, y, text, size=9):
    c.setFont("Helvetica", size)
    c.setFillColor(INK)
    c.drawString(x, y, str(text))


def box(c, x, y, w, h):
    c.setStrokeColor(RULE)
    c.setLineWidth(0.7)
    c.rect(x, y, w, h, stroke=1, fill=0)


def section(c, x, y, w, title):
    c.setFillColor(INK)
    c.rect(x, y, w, 20, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x + 8, y + 6, title)


def address(c, x, y, title, lines):
    label(c, x, y, title)
    for index, line in enumerate(lines):
        value(c, x, y - 17 - index * 13, line, 8.5)


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(612, 792))
    c.setTitle("Pre-shipment Bill of Lading - ORD-001339")
    c.setAuthor("Grey Wolf 3PL & Logistics Inc.")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(28, 752, "STRAIGHT BILL OF LADING")
    c.setFont("Helvetica-Bold", 8)
    c.drawRightString(584, 754, "PRE-SHIPMENT / UNSIGNED")
    value(c, 28, 736, "Original - not negotiable", 8)
    c.setStrokeColor(RULE)
    c.line(28, 726, 584, 726)

    box(c, 28, 633, 275, 86)
    box(c, 309, 633, 275, 86)
    address(c, 37, 704, "Ship from", [
        "Alcona Trading Ltd. c/o Grey Wolf 3PL", "Grey Wolf Edwards Warehouse",
        "6300 Edwards Blvd", "Mississauga, ON L5T 2V7, Canada",
    ])
    address(c, 318, 704, "Ship to", [
        "NUTEM CUSTOM MANUFACTURING", "1105 Clay Ave, Unit 7",
        "Burlington, ON L7L 0A1, Canada",
    ])

    box(c, 28, 548, 556, 78)
    fields = [
        (38, 609, "BOL number", "BOL-ORD-001339"),
        (212, 609, "WMS order", "ORD-001339"),
        (391, 609, "PO number", "529672"),
        (38, 577, "Carrier", "To be assigned at pickup"),
        (212, 577, "Shipping reference", "S2607S00390117"),
        (391, 577, "Requested ship", "Oct 2, 2026"),
    ]
    for x, y, title, content in fields:
        label(c, x, y, title)
        value(c, x, y - 15, content, 8)

    section(c, 28, 517, 556, "FREIGHT DETAILS")
    box(c, 28, 340, 556, 177)
    for x, heading in ((38, "PALLET"), (104, "PICK BIN"), (191, "ITEM / SKU"), (463, "WEIGHT")):
        label(c, x, 500, heading)
    c.setStrokeColor(RULE)
    c.line(28, 492, 584, 492)
    for index, (number, bin_code, weight_lb) in enumerate(PALLETS):
        y = 472 - index * 29
        value(c, 38, y, number)
        value(c, 104, y, bin_code)
        value(c, 191, y, "MS26060402G", 8)
        value(c, 463, y, f"{weight_lb * LB_TO_KG:,.2f} kg", 8)
        c.line(28, y - 9, 584, y - 9)
    label(c, 38, 354, "Total handling units")
    value(c, 191, 354, "4 pallets / 4 totes", 8.5)
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(576, 354, f"{sum(p[2] for p in PALLETS) * LB_TO_KG:,.2f} kg")

    section(c, 28, 310, 556, "FREIGHT TERMS / SPECIAL HANDLING")
    box(c, 28, 207, 556, 103)
    label(c, 38, 292, "Freight charges - select at tender")
    value(c, 38, 276, "[  ] PREPAID    [  ] COLLECT    [  ] THIRD PARTY", 8)
    value(c, 38, 257, "Third-party bill to: _________________________________________________", 8)
    value(c, 38, 239, "Delivery appointment: confirm with Nutem receiving before dispatch.", 7.8)
    value(c, 38, 222, "Inspect totes for damage before loading; note exceptions on this BOL.", 7.8)

    section(c, 28, 178, 556, "PICKUP CERTIFICATION / DELIVERY RECEIPT")
    for index, heading in enumerate(("SHIPPER", "CARRIER / DRIVER", "RECEIVER / PROOF OF DELIVERY")):
        x = 28 + index * (556 / 3)
        box(c, x, 64, 556 / 3, 114)
        label(c, x + 7, 160, heading)
        value(c, x + 7, 136, "Name: _____________________", 7.5)
        value(c, x + 7, 111, "Signature: ________________", 7.5)
        value(c, x + 7, 86, "Date: _______ Time: ______", 7.5)

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7)
    c.drawString(28, 46, "Prepared from staged WMS order; not evidence of carrier pickup or delivery.")
    c.drawString(28, 32, "WMS365 | wms365.co")
    c.drawRightString(584, 32, f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
