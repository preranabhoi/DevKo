import { NextResponse } from 'next/server';

import { checkAuth } from 'lib/auth';

import { expensesCategory } from 'constants/categories';

export const dynamic = 'force-dynamic';

type ExtractedExpense = {
	name: string;
	price: number;
	category?: string;
	notes?: string;
	date?: string;
};

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CONTENT_CHARS_FOR_AI = 16000;

const categoryKeywordMap: Record<string, string[]> = {
	food: ['food', 'swiggy', 'zomato', 'restaurant', 'dining', 'cafe'],
	travel: ['uber', 'ola', 'taxi', 'metro', 'flight', 'train', 'travel'],
	shopping: ['amazon', 'flipkart', 'myntra', 'shopping', 'store'],
	bills: ['bill', 'electricity', 'water', 'gas', 'broadband', 'internet', 'mobile'],
	medical: ['medical', 'hospital', 'pharmacy', 'medicine'],
	entertainment: ['movie', 'netflix', 'spotify', 'hotstar', 'prime'],
};

const normalizeCategory = (value?: string) => {
	if (!value) return 'other';
	const normalized = value.toLowerCase().replace(/[^a-z]/g, '');
	return expensesCategory[normalized] ? normalized : 'other';
};

const detectCategoryFromName = (name: string) => {
	const lowerName = name.toLowerCase();
	const matched = Object.keys(categoryKeywordMap).find((key) =>
		categoryKeywordMap[key].some((keyword) => lowerName.includes(keyword))
	);
	return matched || 'other';
};

const normalizeDate = (value?: string) => {
	if (!value) return new Date().toISOString().slice(0, 10);
	const normalized = value.trim();
	const ddMmYyyy = normalized.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
	if (ddMmYyyy) {
		const day = ddMmYyyy[1].padStart(2, '0');
		const month = ddMmYyyy[2].padStart(2, '0');
		const year = ddMmYyyy[3].length === 2 ? `20${ddMmYyyy[3]}` : ddMmYyyy[3];
		return `${year}-${month}-${day}`;
	}
	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
	return date.toISOString().slice(0, 10);
};

const parseJsonResponse = (value: string) => {
	const trimmed = value.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const withoutMarkdown = trimmed.replace(/```json|```/g, '').trim();
		try {
			return JSON.parse(withoutMarkdown);
		} catch {
			const firstBrace = withoutMarkdown.indexOf('{');
			const lastBrace = withoutMarkdown.lastIndexOf('}');
			if (firstBrace >= 0 && lastBrace > firstBrace) {
				return JSON.parse(withoutMarkdown.slice(firstBrace, lastBrace + 1));
			}
			throw new Error('AI returned invalid JSON format.');
		}
	}
};

const decodeBase64 = (value: string) => Buffer.from(value, 'base64');

const parseCsvLine = (line: string) => {
	const output: string[] = [];
	let current = '';
	let insideQuotes = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === '"') {
			insideQuotes = !insideQuotes;
			continue;
		}
		if (char === ',' && !insideQuotes) {
			output.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	output.push(current.trim());
	return output;
};

const parseCsvExpenses = (fileBuffer: Buffer) => {
	const text = fileBuffer.toString('utf-8');
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (!lines.length) return [];

	const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
	const amountIndex = header.findIndex((value) => ['amount', 'price', 'debit', 'spent'].includes(value));
	const nameIndex = header.findIndex((value) => ['name', 'description', 'merchant', 'narration', 'remarks'].includes(value));
	const dateIndex = header.findIndex((value) => ['date', 'txn date', 'transaction date'].includes(value));
	const typeIndex = header.findIndex((value) => ['type', 'dr/cr', 'transaction type'].includes(value));

	return lines
		.slice(1)
		.map((line) => parseCsvLine(line))
		.map((values) => {
			const rawType = (values[typeIndex] || '').toLowerCase();
			if (rawType.includes('credit') || rawType === 'cr') return null;

			const amountRaw = (values[amountIndex] || '').replace(/[^0-9.-]/g, '');
			const amount = Number(amountRaw);
			if (!Number.isFinite(amount) || amount <= 0) return null;

			const name = (values[nameIndex] || 'Imported expense').slice(0, 30);
			return {
				name,
				price: amount,
				date: normalizeDate(values[dateIndex]),
				category: detectCategoryFromName(name),
				notes: 'Done by UPI import from CSV',
			};
		})
		.filter(Boolean) as ExtractedExpense[];
};

const parsePdfTextExpenses = (fileBuffer: Buffer, fileName: string) => {
	const text = fileBuffer.toString('latin1').replace(/\s+/g, ' ');
	const dateRegex = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/g;
	const amountRegex = /(₹|INR|Rs\.?|MRP)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d{1,2})|[0-9]+(?:\.\d{1,2}))/g;
	const debitTokens = ['debit', 'dr', 'paid', 'upi', 'sent', 'purchase'];
	const creditTokens = ['credit', 'cr', 'refund', 'received', 'reversal'];

	const segments = text.split(/(?=\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/g).slice(0, 500);
	const seen = new Set<string>();

	return segments
		.map((segment) => {
			const lower = segment.toLowerCase();
			const isDebit = debitTokens.some((token) => lower.includes(token));
			const isCredit = creditTokens.some((token) => lower.includes(token));
			if (!isDebit || isCredit) return null;

			const dateMatch = segment.match(dateRegex)?.[0];
			let amountMatch: RegExpExecArray | null = null;
			let latestAmount = 0;
			while (true) {
				amountMatch = amountRegex.exec(segment);
				if (!amountMatch) break;
				const parsed = Number((amountMatch[2] || '').replace(/,/g, ''));
				if (Number.isFinite(parsed) && parsed > latestAmount) latestAmount = parsed;
			}
			amountRegex.lastIndex = 0;
			if (!latestAmount) return null;

			const cleanedName = segment
				.replace(dateRegex, '')
				.replace(amountRegex, '')
				.replace(/[^a-zA-Z0-9\s\-]/g, ' ')
				.trim()
				.split(/\s+/)
				.slice(0, 5)
				.join(' ')
				.slice(0, 30);

			const name = cleanedName || 'UPI Expense';
			const uniqueKey = `${name}-${latestAmount}-${dateMatch}`;
			if (seen.has(uniqueKey)) return null;
			seen.add(uniqueKey);

			return {
				name,
				price: latestAmount,
				date: normalizeDate(dateMatch),
				category: detectCategoryFromName(name),
				notes: `Done by UPI import from ${fileName}`,
			};
		})
		.filter(Boolean) as ExtractedExpense[];
};

const extractPlainTextForAI = (fileBuffer: Buffer, mimeType: string, fileName: string) => {
	if (mimeType.includes('csv') || fileName.toLowerCase().endsWith('.csv')) {
		return fileBuffer.toString('utf-8').slice(0, MAX_CONTENT_CHARS_FOR_AI);
	}

	if (fileName.toLowerCase().endsWith('.xlsx') || fileName.toLowerCase().endsWith('.xls')) {
		return fileBuffer
			.toString('latin1')
			.replace(/[^\x20-\x7E\n]/g, ' ')
			.replace(/\s+/g, ' ')
			.slice(0, MAX_CONTENT_CHARS_FOR_AI);
	}

	return fileBuffer
		.toString('latin1')
		.replace(/[^\x20-\x7E\n]/g, ' ')
		.replace(/\s+/g, ' ')
		.slice(0, MAX_CONTENT_CHARS_FOR_AI);
};

const extractWithGroq = async ({
	apiKey,
	fileName,
	mimeType,
	fileText,
}: {
	apiKey: string;
	fileName: string;
	mimeType: string;
	fileText: string;
}) => {
	const categoryKeys = Object.keys(expensesCategory).filter(Boolean).join(', ');
	const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'llama-3.3-70b-versatile',
			temperature: 0,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content: `You extract expense entries from statement text.
Return ONLY valid JSON with this exact shape:
{
  "expenses": [
    { "name": "string", "price": 0, "date": "YYYY-MM-DD", "category": "${categoryKeys}", "notes": "string" }
  ]
}
Rules:
- Include only outgoing/debit transactions.
- Ignore credit/refund/income.
- Ensure price is a positive number.
- Category must be one of the allowed category keys; if unknown use "other".
- Keep name short (max 30 chars).
- If date unavailable, use today's date.
- Notes should mention imported from ${fileName}.`,
				},
				{
					role: 'user',
					content: `file_name: ${fileName}\nmime_type: ${mimeType}\nstatement_text:\n${fileText}`,
				},
			],
		}),
	});

	const data = await response.json();
	if (!response.ok) {
		throw new Error(data?.error?.message || 'Groq API Error');
	}

	const aiContent = data?.choices?.[0]?.message?.content || '{}';
	return parseJsonResponse(aiContent);
};

const normalizeExpenses = (rows: ExtractedExpense[], fileName: string) =>
	rows
		.map((row) => {
			const price = Number(row.price);
			if (!row.name || !Number.isFinite(price) || price <= 0) return null;

			return {
				name: row.name.slice(0, 30),
				price: price.toString(),
				date: normalizeDate(row.date),
				category: normalizeCategory(row.category),
				notes: (row.notes || `Done by UPI import from ${fileName}`).slice(0, 60),
				paid_via: 'upi',
			};
		})
		.filter(Boolean);

export async function POST(req: Request) {
	return checkAuth(async () => {
		try {
			const { fileName, mimeType, contentBase64 } = await req.json();

			if (!fileName || !contentBase64) {
				return NextResponse.json({ message: 'File details are required.' }, { status: 400 });
			}

			const approxSize = Math.ceil((contentBase64.length * 3) / 4);
			if (approxSize > MAX_FILE_SIZE) {
				return NextResponse.json({ message: 'File too large. Please upload up to 10MB.' }, { status: 400 });
			}

			const lowerFileName = fileName.toLowerCase();
			const fileBuffer = decodeBase64(contentBase64);
			const resolvedMimeType =
				mimeType ||
				(lowerFileName.endsWith('.pdf')
					? 'application/pdf'
					: lowerFileName.endsWith('.csv')
						? 'text/csv'
						: lowerFileName.endsWith('.xlsx')
							? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
							: 'application/octet-stream');

			let fallbackRows: ExtractedExpense[] = [];
			if (lowerFileName.endsWith('.csv') || resolvedMimeType.includes('csv')) {
				fallbackRows = parseCsvExpenses(fileBuffer);
			}
			if (!fallbackRows.length && (lowerFileName.endsWith('.pdf') || resolvedMimeType === 'application/pdf')) {
				fallbackRows = parsePdfTextExpenses(fileBuffer, fileName);
			}

			if (fallbackRows.length) {
				return NextResponse.json({ expenses: normalizeExpenses(fallbackRows, fileName), source: 'fallback-parser' });
			}

			const apiKey = process.env.GROQ_API_KEY;
			if (!apiKey) {
				return NextResponse.json(
					{
						message: 'Failed to import expenses from file.',
						details: 'Could not parse file locally and GROQ_API_KEY is missing for AI extraction.',
					},
					{ status: 500 }
				);
			}

			const fileText = extractPlainTextForAI(fileBuffer, resolvedMimeType, fileName);
			if (!fileText.trim()) {
				return NextResponse.json(
					{
						message: 'Failed to import expenses from file.',
						details: 'No readable text found in the uploaded file.',
					},
					{ status: 500 }
				);
			}

			const parsed = await extractWithGroq({
				apiKey,
				fileName,
				mimeType: resolvedMimeType,
				fileText,
			});
			const rows = Array.isArray(parsed?.expenses) ? parsed.expenses : [];

			return NextResponse.json({ expenses: normalizeExpenses(rows, fileName), source: 'groq' });
		} catch (error: any) {
			return NextResponse.json(
				{
					message: 'Failed to import expenses from file.',
					details: error?.message || 'Unknown parsing error.',
				},
				{ status: 500 }
			);
		}
	}, false);
}