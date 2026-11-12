from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "output/pdf/WMS365_BOL_ORD-001007_2026-09-23.pdf"
OUTPUT = ROOT / "output/pdf/WMS365_BOL_ORD-001007_2026-09-23_AMENDED.pdf"


def line(c, label, y, x=44, width=520):
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x, y, label)
    c.line(x, y - 10, x + width, y - 10)


def main():
    original = PdfReader(str(SOURCE))
    if len(original.pages) != 1 or "ORD-001007" not in original.pages[0].extract_text():
        raise ValueError("Source BOL does not match ORD-001007")

    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)
    c.setTitle("ORD-001007 BOL Amendment - Freight Terms and Delivery Receipt")
    c.setFillColor(colors.HexColor("#17314a"))
    c.setFont("Helvetica-Bold", 16)
    c.drawString(44, 744, "BOL AMENDMENT")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(44, 725, "Freight terms and proof of delivery")
    c.setFillColor(colors.black)
    c.setFont("Helvetica", 9)
    c.drawString(44, 696, "Attach this page to BOL-ORD-001007; it does not replace the original freight details.")
    c.drawString(44, 678, "Order: ORD-001007    Carrier: Truck 4 Delivery    Handling units: 4 pallets")
    c.drawString(44, 660, "Ship to: NUTEM CUSTOM MANUFACTURING, Burlington, ON")

    c.setFillColor(colors.HexColor("#e9eef2"))
    c.rect(44, 617, 524, 24, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(52, 625, "FREIGHT CHARGE TERMS - SELECT ONE BEFORE TENDER")
    c.setFont("Helvetica", 10)
    c.drawString(52, 591, "[   ]  Prepaid          [   ]  Collect          [   ]  Third party")
    line(c, "Third-party freight charges bill to (name and address):", 563)
    c.line(44, 533, 568, 533)
    c.setFont("Helvetica", 8)
    c.drawString(44, 508, "Freight terms are intentionally blank pending shipper/carrier confirmation.")

    c.setFillColor(colors.HexColor("#e9eef2"))
    c.rect(44, 455, 524, 24, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(52, 463, "DELIVERY RECEIPT - COMPLETE AT DELIVERY")
    line(c, "Receiver printed name and company:", 430)
    line(c, "Receiver signature:", 388)
    c.setFont("Helvetica", 9)
    c.drawString(44, 343, "Date: ____________________   Time: ____________________   Time zone: __________")
    c.drawString(44, 313, "Pallets received: __________   Condition:  [   ] Good   [   ] Exceptions noted below")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(44, 280, "Visible damage, shortage, or delivery exceptions:")
    for y in (259, 235, 211):
        c.line(44, y, 568, y)
    c.setFont("Helvetica", 8)
    c.drawString(44, 172, "Receiving signature acknowledges receipt and any recorded exceptions; it does not alter freight payment terms.")
    c.setStrokeColor(colors.HexColor("#b4c0ca"))
    c.line(44, 74, 568, 74)
    c.setFillColor(colors.HexColor("#566777"))
    c.drawString(44, 60, "WMS365 | BOL-ORD-001007 | Amendment page 2 of 2")
    c.save()

    buffer.seek(0)
    supplement = PdfReader(buffer)
    writer = PdfWriter()
    writer.append_pages_from_reader(original)
    writer.append_pages_from_reader(supplement)
    with OUTPUT.open("wb") as stream:
        writer.write(stream)
    print(OUTPUT)


if __name__ == "__main__":
    main()
