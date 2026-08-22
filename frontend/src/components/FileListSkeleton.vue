<script setup>
const props = defineProps({
	variant: { type: String, default: 'row' },
	count: { type: Number, default: 8 },
});

function nameWidth(index) {
	const widths = ['w-1/3', 'w-1/4', 'w-2/5', 'w-1/2', 'w-1/3', 'w-1/4', 'w-2/5', 'w-1/3'];
	return widths[index % widths.length];
}
</script>

<template>
	<div v-if="variant === 'card'" class="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
		<div v-for="n in count" :key="n" class="animate-pulse rounded-[22px] border border-[#e0e3e7] bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
			<div class="flex items-start justify-between gap-3">
				<div class="size-12 rounded-2xl bg-[#f1f3f4] dark:bg-slate-700" />
			</div>
			<div class="mt-4 h-3.5 rounded-full bg-[#eceff1] dark:bg-slate-700" :class="nameWidth(n)" />
			<div class="mt-4 flex w-full items-center justify-between">
				<div class="h-2.5 w-16 rounded-full bg-[#eceff1] dark:bg-slate-700" />
				<div class="h-2.5 w-10 rounded-full bg-[#eceff1] dark:bg-slate-700" />
			</div>
		</div>
	</div>
	<div v-else aria-hidden="true">
		<div v-for="n in count" :key="n" class="grid min-h-[52px] grid-cols-[minmax(260px,2fr)_minmax(150px,1fr)_140px] items-center gap-3 border-t border-[#eceff1] px-[18px] first:border-t-0 dark:border-slate-700">
			<div class="flex min-w-0 items-center gap-2.5">
				<div class="size-[18px] shrink-0 animate-pulse rounded-md bg-[#eceff1] dark:bg-slate-700" />
				<div class="h-3 animate-pulse rounded-full bg-[#eceff1] dark:bg-slate-700" :class="nameWidth(n + 2)" />
			</div>
			<div class="h-3 w-24 animate-pulse rounded-full bg-[#eceff1] dark:bg-slate-700" />
			<div class="h-3 w-14 animate-pulse rounded-full bg-[#eceff1] dark:bg-slate-700" />
		</div>
	</div>
</template>
