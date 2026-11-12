from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "outputs/ord-001204-bol/WMS365_BOL_ORD-001204_2026-09-28.pdf"
OUTPUT = ROOT / "output/pdf/WMS365_BOL_ORD-001204_2026-09-28.pdf"


def section(c, title, y):
    c.setFillColorRGB(0.08, 0.20, 0.29)
    c.rect(40, y, 532, 22, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(49, y + 7, title)
    c.setFillColorRGB(0, 0, 0)


def main():
    original = PdfReader(str(SOURCE))
    if len(original.pages) != 1:
        raise ValueError("Expected one original BOL page")
    text = original.pages[0].extract_text() or ""
    required = (
        "ORD-001204", "Truck 4 Delivery", "09/28/2026", "1:00 PM ET",
        "DI04AA", "DI06AA", "DI08AA", "DI10AA", "4,193.9 KG",
    )
    missing = [value for value in required if value not in text]
    if missing:
        raise ValueError(f"Original BOL is missing reviewed fields: {missing}")

    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)
    c.setTitle("Alcona ORD-001204 Bill of Lading - Freight Terms and Delivery Receipt")
    c.setFont("Helvetica-Bold", 15)
    c.drawString(40, 750, "STRAIGHT BILL OF LADING - CONTINUATION")
    c.setFont("Helvetica", 8)
    c.drawString(40, 734, "Original - Not Negotiable | Attach to BOL-ORD-001204")
    c.line(40, 724, 572, 724)

    c.setFont("Helvetica-Bold", 9)
    c.drawString(40, 704, "BOL No.: BOL-ORD-001204")
    c.drawString(265, 704, "Order: ORD-001204")
    c.drawString(440, 704, "PO: 529671")
    c.setFont("Helvetica", 9)
    c.drawString(40, 686, "Carrier: Truck 4 Delivery")
    c.drawString(265, 686, "4 pallets | 4,193.9 kg")
    c.drawString(40, 668, "Delivery appointment: Monday, September 28, 2026 at 1:00 PM Eastern")
    c.drawString(40, 650, "Consignee: Nutem Custom Manufacturing, 1105 Clay Ave, Unit 7, Burlington, ON")
    c.drawString(40, 632, "EMO reference: S2607S00390117")

    section(c, "FREIGHT CHARGE TERMS - SELECT ONE BEFORE TENDER", 587)
    c.setFont("Helvetica", 10)
    c.drawString(48, 565, "[   ] Prepaid          [   ] Collect          [   ] Third party")
    c.setFont("Helvetica", 8)
    c.drawString(48, 543, "Third-party freight charges bill to (name and address):")
    c.line(48, 525, 564, 525)
    c.line(48, 507, 564, 507)
    c.drawString(48, 487, "Freight terms intentionally unselected until the shipper and carrier confirm them.")

    section(c, "DELIVERY RECEIPT - COMPLETE AT DELIVERY", 446)
    c.setFont("Helvetica", 9)
    c.drawString(48, 426, "Receiver printed name and company:")
    c.line(48, 405, 564, 405)
    c.drawString(48, 385, "Receiver signature:")
    c.line(48, 364, 564, 364)
    c.drawString(48, 342, "Date: ____________________   Time: ____________________   Time zone: __________")
    c.drawString(48, 320, "Pallets received: __________   Condition: [   ] Good   [   ] Exceptions noted below")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(48, 293, "Visible damage, shortage, or delivery exceptions:")
    for y in (272, 248, 224):
        c.line(48, y, 564, y)
    c.setFont("Helvetica", 8)
    c.drawString(48, 198, "Receiver signature acknowledges receipt and recorded exceptions; it does not set payment terms.")

    section(c, "CARRIER DELIVERY RECORD", 154)
    c.setFont("Helvetica", 9)
    c.drawString(48, 133, "Driver printed name: __________________________________________")
    c.drawString(48, 112, "Driver signature: ______________________________________________")
    c.drawString(48, 91, "Arrival: ____________________   Departure: ____________________")
    c.line(40, 62, 572, 62)
    c.setFont("Helvetica", 8)
    c.drawString(40, 47, "WMS365 | BOL-ORD-001204 | Freight terms and delivery receipt continuation | 2 of 2")
    c.save()

    page_number_buffer = BytesIO()
    page_number = canvas.Canvas(page_number_buffer, pagesize=letter)
    page_number.setFillColorRGB(1, 1, 1)
    page_number.rect(413, 628, 60, 18, stroke=0, fill=1)
    page_number.setFillColorRGB(0, 0, 0)
    page_number.setFont("Helvetica", 7)
    page_number.drawString(414, 636, "1 of 2")
    page_number.save()
    page_number_buffer.seek(0)
    original.pages[0].merge_page(PdfReader(page_number_buffer).pages[0])

    buffer.seek(0)
    supplement = PdfReader(buffer)
    writer = PdfWriter()
    writer.append_pages_from_reader(original)
    writer.append_pages_from_reader(supplement)
    writer.add_metadata({"/Title": "BOL-ORD-001204 Alcona Trading Ltd", "/Subject": "Bill of Lading with freight terms and delivery receipt"})
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("wb") as stream:
        writer.write(stream)
    final = PdfReader(str(OUTPUT))
    if len(final.pages) != 2:
        raise ValueError("Final BOL must have two pages")
    final_text = "\n".join(page.extract_text() or "" for page in final.pages)
    for value in (*required, "FREIGHT CHARGE TERMS", "Receiver signature", "Third party"):
        if value not in final_text:
            raise ValueError(f"Final BOL is missing {value}")
    print(OUTPUT)


if __name__ == "__main__":
    main()
