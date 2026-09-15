import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { formatUtc8Stamp, formatUtc8DateStamp } from './utils';

/** Capture a DOM element as a canvas and render it into a PDF page. */
async function elementToPdf(element: HTMLElement, pdf: jsPDF, yOffset = 0) {
  const canvas = await html2canvas(element, {
    backgroundColor: '#0d0d0d',
    scale: 2,
    useCORS: true,
    logging: false,
  });
  const imgData = canvas.toDataURL('image/png');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW;
  const imgH = (canvas.height * imgW) / canvas.width;

  let y = yOffset;
  let remaining = imgH;
  let srcY = 0;

  while (remaining > 0) {
    const sliceH = Math.min(remaining, pageH - y);
    // Use a temp canvas to slice the image into page-height chunks
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = canvas.width;
    tmpCanvas.height = (sliceH * canvas.width) / imgW;
    const ctx = tmpCanvas.getContext('2d')!;
    ctx.drawImage(
      canvas,
      0, srcY * (canvas.width / imgW),
      canvas.width, tmpCanvas.height,
      0, 0,
      canvas.width, tmpCanvas.height,
    );
    if (srcY > 0) pdf.addPage();
    pdf.addImage(tmpCanvas.toDataURL('image/png'), 'PNG', 0, y, imgW, sliceH);
    srcY += sliceH;
    remaining -= sliceH;
    y = 0;
  }
}

/** Add a styled header bar to the PDF. */
function addHeader(pdf: jsPDF, title: string, subtitle?: string) {
  const pageW = pdf.internal.pageSize.getWidth();
  // dark background header
  pdf.setFillColor(13, 13, 13);
  pdf.rect(0, 0, pageW, 22, 'F');
  // orange accent line
  pdf.setDrawColor(255, 69, 0);
  pdf.setLineWidth(0.5);
  pdf.line(0, 22, pageW, 22);
  // title text
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(255, 69, 0);
  pdf.text(title.toUpperCase(), 10, 14);
  if (subtitle) {
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(156, 163, 175);
    pdf.text(subtitle, pageW - 10, 14, { align: 'right' });
  }
}

/** Add a footer with page numbers. */
function addFooter(pdf: jsPDF) {
  const pageCount = pdf.getNumberOfPages();
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(31, 31, 31);
    pdf.setLineWidth(0.3);
    pdf.line(0, pageH - 10, pageW, pageH - 10);
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(107, 114, 128);
    pdf.text('IT HELPDESK SYSTEM · CONFIDENTIAL', 10, pageH - 4);
    pdf.text(`PAGE ${i} / ${pageCount}`, pageW - 10, pageH - 4, { align: 'right' });
    pdf.text(`GENERATED: ${formatUtc8Stamp(new Date())} +08:00`, pageW / 2, pageH - 4, { align: 'center' });
  }
}

/**
 * Export a DOM element to a PDF file.
 * @param element - The element to capture
 * @param filename - Output filename (without .pdf)
 * @param title - Header title
 * @param subtitle - Header subtitle/metadata
 */
export async function exportElementToPdf(
  element: HTMLElement,
  filename: string,
  title: string,
  subtitle?: string,
) {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  addHeader(pdf, title, subtitle);
  await elementToPdf(element, pdf, 26); // 26mm below header
  addFooter(pdf);
  pdf.save(`${filename}.pdf`);
}

/**
 * Export a ticket detail page to PDF.
 */
export async function exportTicketToPdf(ticketNumber: string, element: HTMLElement) {
  return exportElementToPdf(
    element,
    `ticket-${ticketNumber}`,
    `Ticket: ${ticketNumber}`,
    `Exported ${formatUtc8DateStamp(new Date())}`,
  );
}

/**
 * Export the reports dashboard to PDF.
 */
export async function exportReportsToPdf(element: HTMLElement, period?: string) {
  return exportElementToPdf(
    element,
    `helpdesk-report-${formatUtc8DateStamp(new Date())}`,
    'IT Helpdesk Reports',
    period ?? formatUtc8DateStamp(new Date()),
  );
}
