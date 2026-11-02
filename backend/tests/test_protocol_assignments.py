import importlib.util
import io
import zipfile
from pathlib import Path


module_path = Path(__file__).resolve().parents[1] / "protocol-extract.py"
spec = importlib.util.spec_from_file_location("protocol_extract", module_path)
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def worksheet(cells):
    body = "".join(
        f'<c r="{coordinate}" t="inlineStr"><is><t>{value}</t></is></c>'
        for coordinate, value in cells.items()
    )
    return f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">{body}</row></sheetData></worksheet>'


buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="PM DELINEANTE"/><sheet name="Reparto de obras"/><sheet name="INTERIORISTAS"/></sheets></workbook>')
    archive.writestr("xl/worksheets/sheet1.xml", worksheet({
        "A2": "10", "B2": "Obra con avance normal", "B9": "Lunilse (PM)",
        "A11": "10", "B11": "Mar jonica", "D11": "Laura", "R11": "Maite", "U11": "Interiorismo",
    }))
    archive.writestr("xl/worksheets/sheet2.xml", worksheet({"A1": "Pestaña adicional"}))
    archive.writestr("xl/worksheets/sheet3.xml", worksheet({
        "A3": "Amanda (Interiorista)", "A5": "Mar jonica",
        "P3": "Obras Pdte Asignación", "P5": "Mar jonica",
    }))

sections, warnings = extractor.assignment_sections(buffer.getvalue())
assert warnings == [], warnings
assert sections == [
    {"ref": "PM DELINEANTE!B11", "text": "Obra: Mar jonica; PMC: Lunilse; Delineante: Laura; Situación: Obra con avance normal"},
    {"ref": "PM DELINEANTE!R11", "text": "Obra: Maite; Estado: Interiorismo"},
    {"ref": "INTERIORISTAS!A5", "text": "Obra: Mar jonica; Interiorista: Amanda"},
], sections
