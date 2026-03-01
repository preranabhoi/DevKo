'use client';

import { useRef, useState } from 'react';

import { Upload } from 'lucide-react';
import { toast } from 'sonner';

import { incrementUsage } from 'app/dashboard/apis';

import { Button } from 'components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from 'components/ui/dialog';

import { addExpense } from './apis';

const supportedMimeTypes = [
	'application/pdf',
	'text/csv',
	'application/csv',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const acceptedExtensions = ['.pdf', '.csv', '.xls', '.xlsx'];

const fileMatchesAcceptedType = (file: File) => {
	if (supportedMimeTypes.includes(file.type)) return true;
	const lowerCaseName = file.name.toLowerCase();
	return acceptedExtensions.some((extension) => lowerCaseName.endsWith(extension));
};

const toBase64 = async (file: File) => {
	const buffer = await file.arrayBuffer();
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;

	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
	}

	return btoa(binary);
};

type UploadExpensesProps = {
	mutate: () => void;
};

export default function UploadExpenses({ mutate }: UploadExpensesProps) {
	const [open, setOpen] = useState(false);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [isUploading, setIsUploading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const onSelectFile = (file?: File | null) => {
		if (!file) return;
		if (!fileMatchesAcceptedType(file)) {
			toast.error('Please upload a PDF, CSV, or Excel file.');
			return;
		}
		setSelectedFile(file);
	};

	const onUpload = async () => {
		if (!selectedFile) {
			toast.error('Select a file before importing.');
			return;
		}

		try {
			setIsUploading(true);
			const contentBase64 = await toBase64(selectedFile);
			const parseResponse = await fetch('/api/ai/expenses-import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fileName: selectedFile.name,
					mimeType: selectedFile.type || 'application/octet-stream',
					contentBase64,
				}),
			});

			const parseData = await parseResponse.json();
			if (!parseResponse.ok) {
				throw new Error(parseData?.details || parseData?.message || 'Unable to parse uploaded file.');
			}

			const importedRows = Array.isArray(parseData?.expenses) ? parseData.expenses : [];
			if (!importedRows.length) {
				toast.error('No expense rows found in this file.');
				setIsUploading(false);
				return;
			}

			await Promise.all(importedRows.map((expense: any) => addExpense({ ...expense, id: null })));
			incrementUsage();
			toast.success(`Imported ${importedRows.length} expense${importedRows.length > 1 ? 's' : ''} via UPI.`);
			mutate();
			setSelectedFile(null);
			setOpen(false);
		} catch (error: any) {
			toast.error(error?.message || 'Failed to import expenses.');
		} finally {
			setIsUploading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" className="gap-2">
					<Upload className="h-4 w-4" /> Upload File
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Import expenses from file</DialogTitle>
					<DialogDescription>
						Upload PDF, CSV, or Excel files. AI will extract expenses.
					</DialogDescription>
				</DialogHeader>

				<div
					onDragOver={(event) => {
						event.preventDefault();
						setIsDragging(true);
					}}
					onDragLeave={() => setIsDragging(false)}
					onDrop={(event) => {
						event.preventDefault();
						setIsDragging(false);
						onSelectFile(event.dataTransfer.files?.[0]);
					}}
					onClick={() => inputRef.current?.click()}
					className={`cursor-pointer rounded-lg border border-dashed p-6 text-center transition ${
						isDragging ? 'border-primary bg-primary/10' : 'border-muted-foreground/50'
					}`}
				>
					<p className="text-sm font-medium">Drag & drop your file here</p>
					<p className="mt-1 text-xs text-muted-foreground">or click to browse (.pdf, .csv, .xls, .xlsx)</p>
					{selectedFile ? <p className="mt-3 text-xs text-primary">Selected: {selectedFile.name}</p> : null}
					<input
						ref={inputRef}
						hidden
						type="file"
						accept={acceptedExtensions.join(',')}
						onChange={(event) => onSelectFile(event.target.files?.[0])}
					/>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)} disabled={isUploading}>
						Cancel
					</Button>
					<Button onClick={onUpload} disabled={isUploading}>
						{isUploading ? 'Importing...' : 'Import & Add'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}