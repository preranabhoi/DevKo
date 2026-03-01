'use client';

import SummaryCard from 'components/card/summary-card';
import { useUser } from 'components/context/auth-provider';
import { useData } from 'components/context/data-provider';
import CardLoader from 'components/loader/card';

import { formatCurrency } from 'lib/formatter';

import UploadExpenses from './upload-expenses';

export default function ExpensesSummary() {
	const user = useUser();
	const { data = [], loading = true, mutate } = useData();

	return (
		<>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 className="font-semibold text-primary dark:text-white">Summary</h2>
				<UploadExpenses mutate={mutate} />
			</div>
			{loading ? (
				<CardLoader cards={2} className="mb-6" />
			) : (
				<div className="mb-6 grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-5">
					<SummaryCard title="total expenses" data={data.length} />
					<SummaryCard
						title="total amount"
						data={formatCurrency({
							value: data.reduce((acc: any, datum: any) => Number(datum.price) + acc, 0),
							currency: user?.currency,
							locale: user?.locale,
						})}
					/>
					{/* <SummaryCard title="top spent category" data={formatCurrency({ value: 1 })} /> */}
				</div>
			)}
		</>
	);
}