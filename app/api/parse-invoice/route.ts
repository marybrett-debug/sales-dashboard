import { NextRequest, NextResponse } from 'next/server'

/* eslint-disable @typescript-eslint/no-require-imports */
const pdfParse = require('pdf-parse')

interface InvoiceLine {
  strain: string
  packSize: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

interface ParsedInvoice {
  invoiceNumber: string
  customer: string
  date: string | null
  lines: InvoiceLine[]
  subtotal: number
  discount: number
  total: number
}

function parseWSInvoice(text: string): ParsedInvoice | null {
  // Format: Invoice # 2026-WS-1070
  const invMatch = text.match(/Invoice\s*#?\s*([\d\w-]+)/i)
  const custMatch = text.match(/Customer:\s*(.+?)(?:Contact:|\n)/i)

  if (!invMatch) return null

  const lines: InvoiceLine[] = []
  // Match lines like: Afghan Hash Plant - R$1.501,000$1,500.00
  // pdf-parse strips spaces between columns. Unit price always has exactly 2 decimal places
  // so we use \d+\.\d{2} to avoid eating into the quantity field.
  const lineRegex = /^(.+?)\s*\$(\d+\.\d{2})([\d,]+)\s*\$([\d,]+(?:\.\d+)?)/gm
  let m
  while ((m = lineRegex.exec(text)) !== null) {
    const strain = m[1].trim()
    if (strain.toLowerCase() === 'total' || strain.toLowerCase() === 'shipping') continue
    lines.push({
      strain,
      packSize: 'bulk',
      quantity: parseInt(m[3].replace(/,/g, '')),
      unitPrice: parseFloat(m[2]),
      lineTotal: parseFloat(m[4].replace(/,/g, '')),
    })
  }

  const totalMatch = text.match(/Total\s*\$\s*([\d,]+(?:\.\d+)?)/i)
  const total = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : lines.reduce((s, l) => s + l.lineTotal, 0)

  return {
    invoiceNumber: invMatch[1],
    customer: custMatch ? custMatch[1].trim() : 'Unknown',
    date: null, // WS invoices don't have dates
    lines,
    subtotal: total,
    discount: 0,
    total,
  }
}

function parseSunDropsInvoice(text: string): ParsedInvoice | null {
  // Format: Invoice Number: 2026-000153, Date: 25/03/2026
  const invMatch = text.match(/Invoice\s+Number:\s*([\d\w-]+)/i)
  const dateMatch = text.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)
  const clientMatch = text.match(/Invoice Address\s+Delivery Address\s*\n(.+?)(?:\n)/i)
    || text.match(/Invoice Address[\s\S]*?\n([A-Z][\w\s]+(?:Company|LLC|Inc|Corp|Seeds|Seed)[\w\s]*)/i)

  if (!invMatch) return null

  const lines: InvoiceLine[] = []
  // Match lines like: 2000201 Acapulco Gold 1 Seeds 77 $5.85
  // Product Code | Name | Option | Qty | Unit Price
  const lineRegex = /^(\d{7})\s+(.+?)\s+(\d+\s*Seeds?)\s+(\d+)\s+\$([\d,]+(?:\.\d+)?)/gm
  let m
  while ((m = lineRegex.exec(text)) !== null) {
    const seedCount = parseInt(m[3])
    lines.push({
      strain: m[2].trim(),
      packSize: `${seedCount} Seeds`,
      quantity: parseInt(m[4]),
      unitPrice: parseFloat(m[5].replace(/,/g, '')),
      lineTotal: parseInt(m[4]) * parseFloat(m[5].replace(/,/g, '')),
    })
  }

  const subtotalBefore = text.match(/Subtotal\s*\(before discount\):\s*\$([\d,]+(?:\.\d+)?)/i)
  const discountMatch = text.match(/Discount:\s*-?\s*\$([\d,]+(?:\.\d+)?)/i)
  const totalMatch = text.match(/Total:\s*\$([\d,]+(?:\.\d+)?)/i)

  const subtotal = subtotalBefore ? parseFloat(subtotalBefore[1].replace(/,/g, '')) : lines.reduce((s, l) => s + l.lineTotal, 0)
  const discount = discountMatch ? parseFloat(discountMatch[1].replace(/,/g, '')) : 0
  const total = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : subtotal - discount

  // Extract client name from delivery address block
  let customer = 'Unknown'
  if (clientMatch) {
    customer = clientMatch[1].trim()
  } else {
    const addrMatch = text.match(/Delivery Address\s*\n([^\n]+)/i)
    if (addrMatch) customer = addrMatch[1].trim()
  }

  return {
    invoiceNumber: invMatch[1],
    customer,
    date: dateMatch ? dateMatch[1] : null,
    lines,
    subtotal,
    discount,
    total,
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const pdf = await pdfParse(buffer)
    const text = pdf.text

    // Try both parsers — track which format matched
    let parsed: ParsedInvoice | null = null
    let format: 'sundrops' | 'ws' = 'ws'

    if (text.includes('Invoice Number:') || text.includes('Sun Drops') || text.includes('Product Code')) {
      parsed = parseSunDropsInvoice(text)
      if (parsed) format = 'sundrops'
    }

    if (!parsed && (text.includes('Invoice #') || text.includes('Cost per'))) {
      parsed = parseWSInvoice(text)
      if (parsed) format = 'ws'
    }

    if (!parsed) {
      // Try both as fallback
      parsed = parseSunDropsInvoice(text)
      if (parsed) { format = 'sundrops' }
      else { parsed = parseWSInvoice(text); format = 'ws' }
    }

    if (!parsed || parsed.lines.length === 0) {
      return NextResponse.json({
        error: 'Could not parse invoice. Unrecognized format.',
        debug: text.slice(0, 500),
      }, { status: 400 })
    }

    return NextResponse.json({ success: true, invoice: parsed, format })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[parse-invoice]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
