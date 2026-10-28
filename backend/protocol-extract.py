import base64
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def numbered(paths, prefix):
    pattern = re.compile(re.escape(prefix) + r"(\d+)\.xml$")
    return sorted(((int(match.group(1)), path) for path in paths if (match := pattern.search(path))), key=lambda item: item[0])


def text_nodes(root, suffix):
    return [node.text.strip() for node in root.iter() if node.tag.endswith(suffix) and node.text and node.text.strip()]


def safe_archive(data):
    archive = zipfile.ZipFile(io.BytesIO(data))
    if sum(entry.file_size for entry in archive.infolist()) > 100 * 1024 * 1024:
        archive.close()
        raise ValueError("Archivo comprimido demasiado grande")
    return archive


def pptx_sections(data):
    sections = []
    with safe_archive(data) as archive:
        names = archive.namelist()
        notes = {number: path for number, path in numbered(names, "ppt/notesSlides/notesSlide")}
        for number, path in numbered(names, "ppt/slides/slide"):
            slide = ET.fromstring(archive.read(path))
            lines = []
            for shape in slide.iter():
                if shape.tag.endswith("}sp"):
                    for paragraph in shape.iter():
                        if paragraph.tag.endswith("}p"):
                            text = " ".join(text_nodes(paragraph, "}t"))
                            if text:
                                lines.append(text)
                elif shape.tag.endswith("}tbl"):
                    for row in shape:
                        if row.tag.endswith("}tr"):
                            cells = [" ".join(text_nodes(cell, "}t")).replace("|", "\\|") for cell in row if cell.tag.endswith("}tc")]
                            lines.append("| " + " | ".join(cells) + " |")
            if number in notes:
                note = ET.fromstring(archive.read(notes[number]))
                note_text = text_nodes(note, "}t")
                if note_text:
                    lines.append("Notas: " + " ".join(note_text))
            if lines:
                sections.append({"ref": f"diapositiva {number}", "text": "\n".join(lines)})
    return sections, []


def docx_sections(data):
    with safe_archive(data) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    body = root.find("w:body", namespaces)
    if body is None:
        return [], ["Documento sin cuerpo legible"]
    sections = []
    current = {"ref": "inicio", "text": ""}
    for element in body:
        if element.tag.endswith("}p"):
            text = "".join(node.text or "" for node in element.findall(".//w:t", namespaces)).strip()
            if not text:
                continue
            style = element.find("w:pPr/w:pStyle", namespaces)
            heading = style is not None and re.search(r"heading|t.tulo", style.attrib.get(f"{{{namespaces['w']}}}val", ""), re.I)
            if heading and current["text"]:
                sections.append(current)
                current = {"ref": text[:120], "text": ""}
            current["text"] += text + "\n"
        elif element.tag.endswith("}tbl"):
            rows = []
            for row in element.findall("w:tr", namespaces):
                cells = [" ".join(text_nodes(cell, "}t")) for cell in row.findall("w:tc", namespaces)]
                rows.append("| " + " | ".join(cells) + " |")
            current["text"] += "\n".join(rows) + "\n"
    if current["text"]:
        sections.append(current)
    return sections, []


def pdf_sections(data):
    try:
        import pdfplumber
    except ImportError as error:
        raise RuntimeError("Falta pdfplumber para extraer y verificar tablas PDF") from error
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "protocol.pdf"
        source.write_bytes(data)
        command = ["pdftotext", "-layout", "-enc", "UTF-8", str(source), "-"]
        result = subprocess.run(command, capture_output=True, check=False, timeout=90)
        if result.returncode != 0:
            raise RuntimeError("No se pudo extraer el PDF con pdftotext")
        pages = result.stdout.decode("utf-8", errors="replace").split("\f")
        sections = []
        warnings = []
        vision_pages = []
        with pdfplumber.open(source) as document:
            for number, pdf_page in enumerate(document.pages, 1):
                page = pages[number - 1] if number <= len(pages) else ""
                lines = [line.rstrip() for line in page.splitlines() if line.strip()]
                if not lines:
                    warnings.append(f"página {number}: sin capa de texto; excluida")
                    continue
                found_tables = pdf_page.find_tables()
                if len(found_tables) != 1 or len(found_tables[0].columns) < 8:
                    sections.append({"ref": f"página {number}", "text": "\n".join(lines)})
                    continue
                image = io.BytesIO()
                resolution = max(72, min(int(os.environ.get("PROTOCOL_PDF_VISION_RESOLUTION", "100")), 200))
                pdf_page.to_image(resolution=resolution).original.convert("RGB").save(image, format="JPEG", quality=80)
                vision_pages.append({"ref": f"página {number}", "image": base64.b64encode(image.getvalue()).decode("ascii"), "textLayer": page})
                tables = [table.extract() for table in found_tables]
                heading = pdf_page.crop((0, 0, pdf_page.width, min(table.bbox[1] for table in found_tables))).extract_text() or ""
                table_lines = []
                for table in tables:
                    for row in table:
                        cells = [" ".join(str(cell or "").split()).replace("|", "\\|") for cell in row]
                        if any(cells):
                            table_lines.append("| " + " | ".join(cells) + " |")
                layer_words = set(re.findall(r"\w+", unicodedata.normalize("NFC", page).casefold()))
                table_words = set(re.findall(r"\w+", unicodedata.normalize("NFC", "\n".join(table_lines)).casefold()))
                if not table_lines or table_words - layer_words:
                    warnings.append(f"página {number}: tabla con palabras no verificadas en la capa de texto; excluida")
                    continue
                sections.append({"ref": f"página {number}", "text": "\n".join([heading.strip(), *table_lines]).strip()})
    if not sections:
        warnings.append("PDF sin páginas de texto verificables")
    return sections, warnings, vision_pages


def xlsx_sections(data):
    sections = []
    warnings = []
    max_rows = max(1, min(int(os.environ.get("PROTOCOL_SHEET_MAX_ROWS", "500")), 5000))
    with safe_archive(data) as archive:
        names = archive.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(text_nodes(item, "}t")) for item in strings]
        titles = []
        if "xl/workbook.xml" in names:
            workbook = ET.fromstring(archive.read("xl/workbook.xml"))
            titles = [sheet.attrib.get("name", "") for sheet in workbook.iter() if sheet.tag.endswith("}sheet")]
        for number, path in numbered(names, "xl/worksheets/sheet"):
            root = ET.fromstring(archive.read(path))
            rows = []
            for row in root.iter():
                if not row.tag.endswith("}row"):
                    continue
                if len(rows) >= max_rows:
                    warnings.append(f"hoja {number}: se alcanzó el límite de {max_rows} filas")
                    break
                cells = []
                for cell in row:
                    if not cell.tag.endswith("}c"):
                        continue
                    value = next((node.text or "" for node in cell if node.tag.endswith("}v")), "")
                    if cell.attrib.get("t") == "s" and value.isdigit() and int(value) < len(shared):
                        value = shared[int(value)]
                    elif cell.attrib.get("t") == "inlineStr":
                        value = " ".join(text_nodes(cell, "}t"))
                    cells.append(value.replace("|", "\\|"))
                if cells:
                    rows.append("| " + " | ".join(cells) + " |")
            if rows:
                title = titles[number - 1] if number <= len(titles) and titles[number - 1] else str(number)
                sections.append({"ref": f"hoja {title}", "text": "\n".join(rows)})
    return sections, warnings


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    kind = sys.argv[1]
    data = sys.stdin.buffer.read()
    vision_pages = []
    if len(data) > 30 * 1024 * 1024:
        raise ValueError("Archivo de protocolos demasiado grande")
    if kind == "pptx":
        sections, warnings = pptx_sections(data)
    elif kind == "docx":
        sections, warnings = docx_sections(data)
    elif kind == "pdf":
        sections, warnings, vision_pages = pdf_sections(data)
    elif kind == "xlsx":
        sections, warnings = xlsx_sections(data)
    elif kind == "text":
        text = data.decode("utf-8-sig")
        sections, warnings = ([{"ref": "texto", "text": text}] if text.strip() else []), []
    else:
        raise ValueError("Formato no soportado")
    print(json.dumps({"sections": sections, "warnings": warnings, "visionPages": vision_pages}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"sections": [], "warnings": [str(error)]}, ensure_ascii=False))
        sys.exit(1)
