from pathlib import Path
import re
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Preformatted, KeepTogether
)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/yxsona-payment-and-six-platform-authorization-guide.md"
OUTPUT = ROOT / "output/pdf/yxsona-payment-and-six-platform-authorization-guide.pdf"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CnTitle", parent=styles["Title"], fontName=FONT, fontSize=21, leading=28, alignment=TA_CENTER, textColor=colors.HexColor("#123B36"), spaceAfter=8*mm))
styles.add(ParagraphStyle(name="CnSubtitle", parent=styles["Normal"], fontName=FONT, fontSize=9, leading=14, alignment=TA_CENTER, textColor=colors.HexColor("#66736F"), spaceAfter=8*mm))
styles.add(ParagraphStyle(name="CnH2", parent=styles["Heading2"], fontName=FONT, fontSize=15, leading=21, textColor=colors.HexColor("#123B36"), spaceBefore=6*mm, spaceAfter=3*mm, keepWithNext=True))
styles.add(ParagraphStyle(name="CnH3", parent=styles["Heading3"], fontName=FONT, fontSize=11.5, leading=17, textColor=colors.HexColor("#176B59"), spaceBefore=4*mm, spaceAfter=2*mm, keepWithNext=True))
styles.add(ParagraphStyle(name="CnBody", parent=styles["BodyText"], fontName=FONT, fontSize=9.3, leading=15, textColor=colors.HexColor("#25312E"), spaceAfter=2.5*mm))
styles.add(ParagraphStyle(name="CnBullet", parent=styles["BodyText"], fontName=FONT, fontSize=9.2, leading=14, leftIndent=5*mm, firstLineIndent=-3*mm, textColor=colors.HexColor("#25312E"), spaceAfter=1.4*mm))
styles.add(ParagraphStyle(name="CnSmall", parent=styles["BodyText"], fontName=FONT, fontSize=8, leading=11, textColor=colors.HexColor("#66736F")))
styles.add(ParagraphStyle(name="CnCode", parent=styles["Code"], fontName=FONT, fontSize=8, leading=11, leftIndent=3*mm, rightIndent=3*mm, backColor=colors.HexColor("#F1F5F3"), borderColor=colors.HexColor("#D9E4DF"), borderWidth=0.5, borderPadding=3*mm))

def inline(text):
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r"<font name='STSong-Light' color='#176B59'>\1</font>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<font color='#176B59'>\1</font>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    return text

def P(text, style="CnBody"):
    return Paragraph(inline(text), styles[style])

def parse_table(lines):
    rows = []
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if all(set(c) <= set("-:") for c in cells):
            continue
        rows.append([Paragraph(inline(c), styles["CnSmall"]) for c in cells])
    if not rows:
        return Spacer(1, 1)
    col_count = max(len(r) for r in rows)
    for r in rows:
        r.extend([Paragraph("", styles["CnSmall"])] * (col_count - len(r)))
    widths = [((175*mm) / col_count) for _ in range(col_count)]
    table = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#E5F0EC")),
        ("TEXTCOLOR", (0,0), (-1,0), colors.HexColor("#123B36")),
        ("GRID", (0,0), (-1,-1), 0.35, colors.HexColor("#D6E2DD")),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 5), ("RIGHTPADDING", (0,0), (-1,-1), 5),
        ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5),
    ]))
    return KeepTogether([Spacer(1, 1.5*mm), table, Spacer(1, 2.5*mm)])

def build_story():
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    story, i = [], 0
    in_code = False
    code = []
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            if not in_code:
                in_code = True; code = []
            else:
                story.append(Preformatted("\n".join(code), styles["CnCode"]))
                story.append(Spacer(1, 2*mm)); in_code = False
            i += 1; continue
        if in_code:
            code.append(line); i += 1; continue
        if not line.strip():
            i += 1; continue
        if line.startswith("> "):
            story.append(P(line[2:], "CnSubtitle")); i += 1; continue
        if line.startswith("# "):
            story.append(P(line[2:], "CnTitle")); i += 1; continue
        if line.startswith("## "):
            story.append(P(line[3:], "CnH2")); i += 1; continue
        if line.startswith("### "):
            story.append(P(line[4:], "CnH3")); i += 1; continue
        if line.startswith("| "):
            block = []
            while i < len(lines) and lines[i].startswith("|"):
                block.append(lines[i]); i += 1
            story.append(parse_table(block)); continue
        if re.match(r"^[-*] ", line):
            story.append(P("- " + line[2:], "CnBullet")); i += 1; continue
        if re.match(r"^\d+\. ", line):
            story.append(P(line, "CnBullet")); i += 1; continue
        story.append(P(line)); i += 1
    return story

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D6E2DD")); canvas.setLineWidth(0.5)
    canvas.line(18*mm, 14*mm, 192*mm, 14*mm)
    canvas.setFont(FONT, 7.5); canvas.setFillColor(colors.HexColor("#7A8782"))
    canvas.drawString(18*mm, 9*mm, "yxsona.com · 支付与六平台授权指南")
    canvas.drawRightString(192*mm, 9*mm, f"第 {doc.page} 页")
    canvas.restoreState()

doc = BaseDocTemplate(str(OUTPUT), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=16*mm, bottomMargin=20*mm, title="yxsona.com 支付与六平台授权开通指南", author="Codex")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
doc.addPageTemplates([PageTemplate(id="main", frames=frame, onPage=footer)])
doc.build(build_story())
print(OUTPUT)
