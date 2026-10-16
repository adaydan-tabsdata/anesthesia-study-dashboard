import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useDiveState, useExport, useSQLQuery } from './shim';
import * as d3 from 'd3';
import {
	Activity,
	ChevronDown,
	Download,
	HeartPulse,
	LayoutDashboard,
	LineChart as LineChartIcon,
	Moon,
	PawPrint,
	Search,
	Stethoscope,
	Sun,
	Thermometer,
	Timer,
} from 'lucide-react';
import {
	Area,
	Bar,
	BarChart,
	CartesianGrid,
	ComposedChart,
	Line,
	ReferenceArea,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts';

export const REQUIRED_DATABASES = [
	{
		type: 'database',
		path: 'md:tabsdata_animal_research',
		alias: 'tabsdata_animal_research',
	},
];

const DB = '"tabsdata_animal_research"."main"';
const N = (value: unknown): number => (value == null ? 0 : Number(value));
const S = (value: unknown): string => (value == null ? '' : String(value));
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

// light and dark themes, the dark one matches the anesthesia video cards, series
// colors in both were run through the colorblind and contrast validator against
// their card surface
const THEMES = {
	dark: {
		scheme: 'dark' as const,
		bg: '#0e0e0e',
		surface: '#18181b',
		raised: '#222226',
		border: '#2e2e33',
		text: '#f2f2f2',
		muted: '#8e8e93',
		accent: '#4cbb3f',
		accentBg: '#13210f',
		accentEdge: 'rgba(76,187,63,0.55)',
		data: '#3a9be0',
		danger: '#ef5a48',
		dangerBg: '#2a1412',
		dangerEdge: 'rgba(239,90,72,0.45)',
		grid: '#2a2a2e',
		shade: '#ffffff',
		shadeOpacity: [0.035, 0.07],
		series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'],
	},
	light: {
		scheme: 'light' as const,
		bg: '#f4f4f5',
		surface: '#ffffff',
		raised: '#f4f4f5',
		border: '#e4e4e7',
		text: '#18181b',
		muted: '#71717a',
		accent: '#2d7a00',
		accentBg: '#eaf4e4',
		accentEdge: 'rgba(45,122,0,0.45)',
		data: '#0777b3',
		danger: '#bc1200',
		dangerBg: '#fdecea',
		dangerEdge: 'rgba(188,18,0,0.35)',
		grid: '#eeeeee',
		shade: '#000000',
		shadeOpacity: [0.03, 0.06],
		series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
	},
};
type Theme = (typeof THEMES)['dark'];
const ThemeContext = createContext<Theme>(THEMES.dark);
const useTheme = () => useContext(ThemeContext);

// scroll areas use a thin scrollbar in the theme's border color and never scroll sideways
const scrollArea = (t: Theme): React.CSSProperties => ({
	overflowY: 'auto',
	overflowX: 'hidden',
	scrollbarWidth: 'thin',
	scrollbarColor: `${t.border} transparent`,
});

const tooltipBox = (t: Theme): React.CSSProperties => ({
	background: t.surface,
	border: `1px solid ${t.border}`,
	borderRadius: 10,
	fontSize: 12,
	color: t.text,
	padding: '6px 10px',
	boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
});

// monitor readings the charts can show, each has its own unit so they never share an axis
const VITALS = {
	map: { label: 'Mean arterial pressure', short: 'MAP', unit: 'mmHg', sql: 'coalesce(ibp_mean_mmhg, nibp_mean_mmhg)', threshold: { value: 60, label: 'hypotension < 60' } },
	hr: { label: 'Heart rate', short: 'HR', unit: 'bpm', sql: 'heart_rate_bpm', threshold: { value: 60, label: 'bradycardia < 60' } },
	etco2: { label: 'End tidal CO2', short: 'ETCO2', unit: 'mmHg', sql: 'etco2_mmhg', threshold: { value: 45, label: 'hypercapnia > 45' } },
	spo2: { label: 'SpO2', short: 'SpO2', unit: '%', sql: 'spo2_pct', threshold: { value: 95, label: 'desaturation < 95' } },
	temp: { label: 'Temperature', short: 'Temp', unit: '°F', sql: 'temperature_f', threshold: { value: 97, label: 'hypothermia < 97' } },
} as const;
type VitalKey = keyof typeof VITALS;
const VITAL_KEYS = Object.keys(VITALS) as VitalKey[];

// complication definitions, a dog counts once if any reading crosses the line
const COMPLICATIONS = [
	{ key: 'hypercapnia', name: 'Hypercapnia', rule: 'ETCO2 > 45 mmHg' },
	{ key: 'bradycardia', name: 'Bradycardia', rule: 'HR < 60 bpm' },
	{ key: 'hypotension', name: 'Hypotension', rule: 'MAP < 60 mmHg' },
	{ key: 'hypothermia', name: 'Hypothermia', rule: 'Temp < 97 °F' },
	{ key: 'desaturation', name: 'Desaturation', rule: 'SpO2 < 95%' },
] as const;
type ComplicationKey = (typeof COMPLICATIONS)[number]['key'];

const COMPLICATION_FLAGS = `
	coalesce(bool_or(coalesce(v.ibp_mean_mmhg, v.nibp_mean_mmhg) < 60), false) AS hypotension,
	coalesce(bool_or(v.heart_rate_bpm < 60), false) AS bradycardia,
	coalesce(bool_or(v.etco2_mmhg > 45), false) AS hypercapnia,
	coalesce(bool_or(v.spo2_pct < 95), false) AS desaturation,
	coalesce(bool_or(v.temperature_f < 97), false) AS hypothermia`;

// study overlays for the vitals charts, computed per 5 minute bucket across every dog in the study
const STATS = [
	{ key: 'median', label: 'Median' },
	{ key: 'mean', label: 'Mean' },
	{ key: 'iqr', label: 'IQR band' },
	{ key: 'range', label: 'Min–max band' },
] as const;
type StatKey = (typeof STATS)[number]['key'];

const PATIENT_LIST_SQL = `
	SELECT c.case_id,
		coalesce(p.animal_name, 'Patient ' || c.patient_id) AS animal_name,
		coalesce(p.breed, 'unknown breed') AS breed,
		c.physical_status,
		strftime(min(c.procedure_date), '%b %d') AS procedure_day,
		${COMPLICATION_FLAGS}
	FROM ${DB}."fct_anesthesia_case" c
	LEFT JOIN ${DB}."dim_patient" p ON p.patient_id = c.patient_id
	LEFT JOIN ${DB}."fct_vital_sign" v ON v.case_id = c.case_id
	GROUP BY c.case_id, p.animal_name, c.patient_id, p.breed, c.physical_status
	ORDER BY min(c.procedure_date), c.case_id
`;

type Patient = { caseId: string; name: string; breed: string; asa: string; day: string; flags: Record<ComplicationKey, boolean> };
const toPatients = (data: unknown): Patient[] =>
	(Array.isArray(data) ? data : []).map((r) => ({
		caseId: S(r.case_id),
		name: S(r.animal_name),
		breed: S(r.breed),
		asa: S(r.physical_status),
		day: S(r.procedure_day),
		flags: Object.fromEntries(COMPLICATIONS.map((item) => [item.key, Boolean(r[item.key])])) as Record<ComplicationKey, boolean>,
	}));

// y range padded so a threshold line and its label never sit on the chart edge
function niceDomain(values: number[]) {
	const lo = d3.min(values) ?? 0;
	const hi = d3.max(values) ?? 1;
	const pad = Math.max((hi - lo) * 0.08, 1);
	return d3.scaleLinear().domain([lo - pad, hi + pad]).nice(5);
}
const hourTicks = (lastMinute: number) => d3.range(0, Math.ceil(Math.max(60, lastMinute) / 60) * 60 + 1, 60);

const BUCKETS_SQL = `
	SELECT case_id,
		floor(minutes_since_start / 5) * 5 AS minute,
		avg(coalesce(ibp_mean_mmhg, nibp_mean_mmhg)) AS map,
		avg(heart_rate_bpm) AS hr,
		avg(etco2_mmhg) AS etco2,
		avg(spo2_pct) AS spo2,
		avg(temperature_f) AS temp
	FROM ${DB}."fct_vital_sign"
	WHERE minutes_since_start >= 0
	GROUP BY ALL
	ORDER BY minute
`;
type Bucket = { caseId: string; minute: number } & Record<VitalKey, number | null>;
type StudyStat = { n: number; mean: number; median: number; iqr: [number, number]; range: [number, number] };

// hook that loads every dog's readings in 5 minute buckets and computes the study
// wide stats per bucket, buckets with fewer than 3 dogs get no stats
function useStudyVitals() {
	const query = useSQLQuery(BUCKETS_SQL);
	const buckets = useMemo<Bucket[]>(
		() =>
			(Array.isArray(query.data) ? query.data : []).map((r) => ({
				caseId: S(r.case_id),
				minute: N(r.minute),
				...(Object.fromEntries(VITAL_KEYS.map((key) => [key, r[key] == null ? null : N(r[key])])) as Record<VitalKey, number | null>),
			})),
		[query.data],
	);
	const stats = useMemo(() => {
		const out = {} as Record<VitalKey, Map<number, StudyStat>>;
		for (const key of VITAL_KEYS) {
			const byMinute = d3.group(
				buckets.filter((b) => b[key] != null),
				(b) => b.minute,
			);
			const map = new Map<number, StudyStat>();
			for (const [minute, list] of byMinute) {
				const vals = list.map((b) => b[key] as number).sort(d3.ascending);
				if (vals.length < 3) continue;
				map.set(minute, {
					n: vals.length,
					mean: d3.mean(vals) as number,
					median: d3.quantileSorted(vals, 0.5) as number,
					iqr: [d3.quantileSorted(vals, 0.25) as number, d3.quantileSorted(vals, 0.75) as number],
					range: [vals[0], vals[vals.length - 1]],
				});
			}
			out[key] = map;
		}
		return out;
	}, [buckets]);
	return { query, buckets, stats };
}

// chart layers for the selected study overlays, drawn under the dog lines
function overlayLayers(t: Theme, stats: StatKey[]) {
	return [
		stats.includes('range') ? <Area key="range" dataKey="range" type="linear" stroke="none" fill={t.text} fillOpacity={0.07} isAnimationActive={false} /> : null,
		stats.includes('iqr') ? <Area key="iqr" dataKey="iqr" type="linear" stroke="none" fill={t.text} fillOpacity={0.14} isAnimationActive={false} /> : null,
		stats.includes('mean') ? <Line key="mean" dataKey="mean" type="linear" stroke={t.text} strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} /> : null,
		stats.includes('median') ? (
			<Line key="median" dataKey="median" type="linear" stroke={t.text} strokeWidth={2.5} strokeDasharray="6 4" dot={false} connectNulls isAnimationActive={false} />
		) : null,
	];
}

// toggle chips plus a legend for the study overlays
function OverlayControls({ stats, setStats }: { stats: StatKey[]; setStats: (next: StatKey[]) => void }) {
	const t = useTheme();
	const toggle = (key: StatKey) => setStats(stats.includes(key) ? stats.filter((s) => s !== key) : [...stats, key]);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-xs mr-1" style={{ color: t.muted }}>
				Study overlay
			</span>
			{STATS.map((s) => (
				<Chip key={s.key} active={stats.includes(s.key)} onClick={() => toggle(s.key)}>
					{s.label}
				</Chip>
			))}
		</div>
	);
}

function OverlayLegend({ stats }: { stats: StatKey[] }) {
	const t = useTheme();
	return (
		<>
			{stats.includes('median') ? (
				<span className="flex items-center gap-1.5">
					<span style={{ width: 16, borderTop: `2.5px dashed ${t.text}` }} /> study median
				</span>
			) : null}
			{stats.includes('mean') ? (
				<span className="flex items-center gap-1.5">
					<span style={{ width: 16, height: 3, background: t.text }} /> study mean
				</span>
			) : null}
			{stats.includes('iqr') ? (
				<span className="flex items-center gap-1.5">
					<span style={{ width: 14, height: 10, background: t.text, opacity: 0.16, borderRadius: 2 }} /> study 25th–75th percentile
				</span>
			) : null}
			{stats.includes('range') ? (
				<span className="flex items-center gap-1.5">
					<span style={{ width: 14, height: 10, background: t.text, opacity: 0.07, borderRadius: 2 }} /> study min–max
				</span>
			) : null}
		</>
	);
}

// tooltip lines for the selected study overlays at one bucket
function OverlayTooltipLines({ row, stats, unit }: { row: Record<string, unknown>; stats: StatKey[]; unit: string }) {
	const fmt = (v: unknown) => (typeof v === 'number' ? `${Number(v.toFixed(1))} ${unit}` : '—');
	return (
		<>
			{stats.includes('median') ? <p>study median {fmt(row.median)}</p> : null}
			{stats.includes('mean') ? <p>study mean {fmt(row.mean)}</p> : null}
			{stats.includes('iqr') && Array.isArray(row.iqr) ? (
				<p>
					study IQR {fmt(row.iqr[0])} – {fmt(row.iqr[1])}
				</p>
			) : null}
			{stats.includes('range') && Array.isArray(row.range) ? (
				<p>
					study range {fmt(row.range[0])} – {fmt(row.range[1])}
				</p>
			) : null}
		</>
	);
}

function Skeleton({ height, width }: { height: number; width?: number | string }) {
	const t = useTheme();
	return <div className="animate-pulse rounded-lg" style={{ height, width: width ?? '100%', background: t.raised }} />;
}

function Card({ title, description, action, children }: { title?: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
	const t = useTheme();
	return (
		<section className="p-4" style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14 }}>
			{title ? (
				<header className="flex items-start justify-between gap-3 mb-3">
					<div>
						<h2 className="text-sm font-semibold" style={{ color: t.text }}>
							{title}
						</h2>
						{description ? (
							<p className="text-xs mt-0.5" style={{ color: t.muted }}>
								{description}
							</p>
						) : null}
					</div>
					{action}
				</header>
			) : null}
			{children}
		</section>
	);
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'danger' }) {
	const t = useTheme();
	const colors =
		tone === 'accent'
			? { color: t.accent, background: t.accentBg, border: t.accentEdge }
			: tone === 'danger'
				? { color: t.danger, background: t.dangerBg, border: t.dangerEdge }
				: { color: t.muted, background: t.raised, border: t.border };
	return (
		<span className="text-xs px-2 py-0.5 whitespace-nowrap" style={{ color: colors.color, background: colors.background, border: `1px solid ${colors.border}`, borderRadius: 999 }}>
			{children}
		</span>
	);
}

function StatCard({
	icon: Icon,
	label,
	value,
	sub,
	loading,
}: {
	icon: React.ComponentType<{ size?: number; color?: string }>;
	label: string;
	value: string;
	sub: string;
	loading: boolean;
}) {
	const t = useTheme();
	return (
		<Card>
			<div className="flex items-center justify-between">
				<p className="text-xs" style={{ color: t.muted }}>
					{label}
				</p>
				<Icon size={15} color={t.muted} />
			</div>
			{loading ? (
				<div className="mt-2">
					<Skeleton height={34} width={80} />
				</div>
			) : (
				<p className="text-3xl font-bold mt-1" style={{ color: t.text }}>
					{value}
				</p>
			)}
			<p className="text-xs mt-1" style={{ color: t.muted }}>
				{sub}
			</p>
		</Card>
	);
}

function ErrorText({ error }: { error: unknown }) {
	const t = useTheme();
	return (
		<p role="alert" className="text-xs" style={{ color: t.danger }}>
			{String(error)}
		</p>
	);
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
	const t = useTheme();
	return (
		<th className={right ? 'font-normal text-xs py-1.5 pr-2 text-right' : 'font-normal text-xs py-1.5 pr-2 text-left'} style={{ color: t.muted }}>
			{children}
		</th>
	);
}

// small toggle button used for vital pickers and timeline overlays
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
	const t = useTheme();
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className="text-xs px-2.5 py-1"
			style={{
				borderRadius: 7,
				background: active ? t.accentBg : 'transparent',
				color: active ? t.accent : t.muted,
				border: `1px solid ${active ? t.accentEdge : t.border}`,
			}}
		>
			{children}
		</button>
	);
}

// dropdown with checkboxes, closes on an outside click
function MultiSelect({
	label,
	options,
	value,
	onChange,
	emptyLabel,
	allowEmpty,
}: {
	label: string;
	options: { value: string; label: string; hint?: string }[];
	value: string[];
	onChange: (next: string[]) => void;
	emptyLabel: string;
	allowEmpty: boolean;
}) {
	const t = useTheme();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [open]);
	const summary =
		value.length === 0 ? emptyLabel : value.length === 1 ? (options.find((o) => o.value === value[0])?.label ?? '1 selected') : value.length === options.length ? 'All' : `${value.length} selected`;
	const toggle = (v: string) => {
		const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
		if (next.length === 0 && !allowEmpty) return;
		onChange(options.map((o) => o.value).filter((o) => next.includes(o)));
	};
	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex items-center gap-2 text-sm px-3 py-1.5"
				style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 9, color: t.text }}
			>
				<span style={{ color: t.muted }}>{label}:</span> {summary}
				<ChevronDown size={14} color={t.muted} />
			</button>
			{open ? (
				<div className="absolute mt-1 p-1" style={{ zIndex: 20, minWidth: 240, maxHeight: 340, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.25)', ...scrollArea(t) }}>
					<div className="flex justify-between px-2 py-1 text-xs">
						<button type="button" onClick={() => onChange(options.map((o) => o.value))} style={{ color: t.accent }}>
							Select all
						</button>
						{allowEmpty ? (
							<button type="button" onClick={() => onChange([])} style={{ color: t.muted }}>
								Clear
							</button>
						) : null}
					</div>
					{options.map((o) => (
						<label key={o.value} className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer" style={{ color: t.text, borderRadius: 7 }}>
							<input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} style={{ accentColor: t.accent }} />
							<span>{o.label}</span>
							{o.hint ? (
								<span className="text-xs ml-auto" style={{ color: t.muted }}>
									{o.hint}
								</span>
							) : null}
						</label>
					))}
				</div>
			) : null}
		</div>
	);
}

// study overview: aggregate metrics only, no per patient detail
function Overview({ onDrill }: { onDrill: (complication: ComplicationKey) => void }) {
	const t = useTheme();
	const summary = useSQLQuery(`
		SELECT count(*) AS cases,
			median(anesthesia_minutes) AS median_minutes,
			quantile_cont(anesthesia_minutes, 0.25) AS q1,
			quantile_cont(anesthesia_minutes, 0.75) AS q3,
			median(age_years) AS median_age,
			median(weight_kg) AS median_weight,
			count(*) FILTER (WHERE recovery_quality = 'Excellent') AS excellent,
			count(*) FILTER (WHERE is_emergency) AS emergencies,
			strftime(min(procedure_date), '%b %Y') || ' – ' || strftime(max(procedure_date), '%b %Y') AS date_range
		FROM ${DB}."fct_anesthesia_case"
	`);
	const complications = useSQLQuery(`
		WITH per_case AS (
			SELECT c.case_id, ${COMPLICATION_FLAGS}
			FROM ${DB}."fct_anesthesia_case" c
			LEFT JOIN ${DB}."fct_vital_sign" v ON v.case_id = c.case_id
			GROUP BY 1
		)
		SELECT count(*) AS total,
			sum(hypotension::int) AS hypotension,
			sum(bradycardia::int) AS bradycardia,
			sum(hypercapnia::int) AS hypercapnia,
			sum(desaturation::int) AS desaturation,
			sum(hypothermia::int) AS hypothermia
		FROM per_case
	`);
	const meds = useSQLQuery(`
		SELECT drug_name,
			count(DISTINCT case_id) AS cases_given,
			100.0 * count(DISTINCT case_id) / (SELECT count(*) FROM ${DB}."fct_anesthesia_case") AS pct_cases,
			count(*) AS administrations,
			mode(dose_unit) AS unit,
			median(dose_amount) AS median_dose,
			mode(reason_given) AS reason
		FROM ${DB}."fct_medication"
		GROUP BY 1
		ORDER BY cases_given DESC, administrations DESC, drug_name
	`);
	const monthly = useSQLQuery(`
		SELECT strftime(t.m, '%b') AS month, count(c.case_id) AS cases
		FROM generate_series(
			(SELECT date_trunc('month', min(procedure_date)) FROM ${DB}."fct_anesthesia_case"),
			(SELECT date_trunc('month', max(procedure_date)) FROM ${DB}."fct_anesthesia_case"),
			INTERVAL 1 MONTH
		) AS t(m)
		LEFT JOIN ${DB}."fct_anesthesia_case" c ON date_trunc('month', c.procedure_date) = t.m
		GROUP BY t.m
		ORDER BY t.m
	`);
	const recovery = useSQLQuery(`
		SELECT physical_status AS asa,
			count(*) FILTER (WHERE recovery_quality = 'Excellent') AS excellent,
			count(*) FILTER (WHERE recovery_quality = 'Good') AS good,
			count(*) FILTER (WHERE recovery_quality = 'Fair') AS fair,
			median(recovery_minutes) AS median_recovery
		FROM ${DB}."fct_anesthesia_case"
		GROUP BY 1
		ORDER BY 1
	`);

	const { exportQuery } = useExport();
	const [exportStatus, setExportStatus] = useState<string | null>(null);
	const EXPORTS = [
		{
			name: 'Case summary',
			filename: 'anesthesia_cases',
			sql: `SELECT p.animal_name, p.breed, p.date_of_birth, c.*
				FROM ${DB}."fct_anesthesia_case" c
				LEFT JOIN ${DB}."dim_patient" p ON p.patient_id = c.patient_id
				ORDER BY c.procedure_date, c.case_id`,
		},
		{ name: 'Vitals', filename: 'anesthesia_vitals', sql: `SELECT * FROM ${DB}."fct_vital_sign" ORDER BY case_id, reading_time` },
		{ name: 'Medications', filename: 'anesthesia_medications', sql: `SELECT * FROM ${DB}."fct_medication" ORDER BY case_id, med_admin_id` },
		{ name: 'Labs', filename: 'anesthesia_labs', sql: `SELECT * FROM ${DB}."fct_lab_result" ORDER BY case_id, lab_result_id` },
		{ name: 'Remarks', filename: 'anesthesia_remarks', sql: `SELECT * FROM ${DB}."fct_case_remark" ORDER BY case_id, remark_time` },
	];
	const runExport = async (e: (typeof EXPORTS)[number]) => {
		setExportStatus(`Preparing ${e.name.toLowerCase()}…`);
		try {
			await exportQuery({ sql: e.sql, format: 'csv', filename: e.filename });
			setExportStatus(`${e.name} exported`);
		} catch (err) {
			setExportStatus(`Export failed: ${String(err)}`);
		}
	};

	const s = (Array.isArray(summary.data) ? summary.data : [])[0];
	const c = (Array.isArray(complications.data) ? complications.data : [])[0];
	const total = N(c?.total);
	const medRows = (Array.isArray(meds.data) ? meds.data : []).map((r) => ({
		drug: S(r.drug_name),
		pct: N(r.pct_cases),
		cases: N(r.cases_given),
		administrations: N(r.administrations),
		dose: `${N(r.median_dose)} ${S(r.unit)}`,
		reason: S(r.reason),
	}));
	const monthRows = (Array.isArray(monthly.data) ? monthly.data : []).map((r) => ({ month: S(r.month), cases: N(r.cases) }));
	const recoveryRows = (Array.isArray(recovery.data) ? recovery.data : []).map((r) => ({
		asa: S(r.asa),
		excellent: N(r.excellent),
		good: N(r.good),
		fair: N(r.fair),
		median: N(r.median_recovery),
	}));

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-4 gap-4">
				<StatCard icon={PawPrint} loading={summary.isLoading} label="Cases" value={s ? S(N(s.cases)) : ''} sub={s ? S(s.date_range) : ' '} />
				<StatCard
					icon={Timer}
					loading={summary.isLoading}
					label="Median anesthesia"
					value={s ? `${Math.round(N(s.median_minutes))} min` : ''}
					sub={s ? `IQR ${Math.round(N(s.q1))}–${Math.round(N(s.q3))} min` : ' '}
				/>
				<StatCard
					icon={Stethoscope}
					loading={summary.isLoading}
					label="Median age"
					value={s ? `${N(s.median_age).toFixed(1)} y` : ''}
					sub={s ? `median weight ${N(s.median_weight).toFixed(1)} kg` : ' '}
				/>
				<StatCard
					icon={HeartPulse}
					loading={summary.isLoading}
					label="Excellent recoveries"
					value={s ? `${N(s.excellent)} of ${N(s.cases)}` : ''}
					sub={s ? `${N(s.emergencies)} emergency cases` : ' '}
				/>
			</div>

			<div className="grid grid-cols-2 gap-4">
				<Card title="Complications" description="Dogs with at least one reading past the threshold">
					{complications.isLoading ? (
						<Skeleton height={170} />
					) : complications.isError ? (
						<ErrorText error={complications.error} />
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr>
									<Th>Event</Th>
									<Th>Threshold</Th>
									<Th right>Dogs</Th>
									<th style={{ width: 80 }} />
									<th style={{ width: 20 }} />
								</tr>
							</thead>
							<tbody>
								{COMPLICATIONS.map((item) => {
									const dogs = N(c?.[item.key]);
									const share = total ? dogs / total : 0;
									return (
										<tr key={item.key} onClick={() => onDrill(item.key)} className="cursor-pointer" title={`Show the dogs with ${item.name.toLowerCase()}`} style={{ borderTop: `1px solid ${t.border}` }}>
											<td className="py-1.5 pr-2" style={{ color: t.text }}>
												{item.name}
											</td>
											<td className="py-1.5 pr-2 text-xs" style={{ color: t.muted }}>
												{item.rule}
											</td>
											<td className="py-1.5 pr-2 text-right" style={{ color: t.text }}>
												{dogs} / {total}
											</td>
											<td className="py-1.5">
												<div style={{ height: 6, borderRadius: 4, background: t.raised }}>
													<div style={{ height: 6, width: `${share * 100}%`, borderRadius: 4, background: t.danger }} />
												</div>
											</td>
											<td className="py-1.5 text-right text-xs" style={{ color: t.muted }}>
												›
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
					<p className="text-xs mt-3" style={{ color: t.muted }}>
						Each dog counts once per event. Invasive MAP is used when an arterial line was placed, cuff MAP otherwise. Click an event to open those dogs in Patients.
					</p>
				</Card>

				<Card title="Medications used" description="Share of cases given each drug, hover for doses">
					{meds.isLoading ? (
						<Skeleton height={300} />
					) : meds.isError ? (
						<ErrorText error={meds.error} />
					) : (
						<ResponsiveContainer width="100%" height={Math.max(160, medRows.length * 19 + 20)}>
							<BarChart data={medRows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={3}>
								<XAxis type="number" domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v) => `${v}%`} fontSize={10} stroke={t.muted} tickLine={false} />
								<YAxis type="category" dataKey="drug" width={96} fontSize={11} stroke={t.muted} tickLine={false} axisLine={false} interval={0} />
								<Tooltip
									cursor={{ fill: t.raised }}
									content={({ active, payload }) => {
										const row = active && payload && payload[0] ? (payload[0].payload as (typeof medRows)[number]) : null;
										return row ? (
											<div style={tooltipBox(t)}>
												<p style={{ fontWeight: 600 }}>{row.drug}</p>
												<p style={{ color: t.muted }}>
													{row.cases} of {total || 20} cases · {row.administrations} doses
												</p>
												<p style={{ color: t.muted }}>
													median dose {row.dose} · {row.reason}
												</p>
											</div>
										) : null;
									}}
								/>
								<Bar dataKey="pct" fill={t.data} radius={[0, 4, 4, 0]} isAnimationActive={false} />
							</BarChart>
						</ResponsiveContainer>
					)}
				</Card>
			</div>

			<div className="grid grid-cols-2 gap-4">
				<Card title="Cases per month" description="Enrollment by procedure date">
					{monthly.isLoading ? (
						<Skeleton height={160} />
					) : monthly.isError ? (
						<ErrorText error={monthly.error} />
					) : (
						<ResponsiveContainer width="100%" height={160}>
							<BarChart data={monthRows} margin={{ top: 4, right: 4, bottom: 0, left: -24 }} barCategoryGap={6}>
								<CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
								<XAxis dataKey="month" fontSize={11} stroke={t.muted} tickLine={false} />
								<YAxis allowDecimals={false} fontSize={11} stroke={t.muted} tickLine={false} axisLine={false} />
								<Tooltip
									cursor={{ fill: t.raised }}
									content={({ active, payload }) =>
										active && payload && payload[0] ? (
											<div style={tooltipBox(t)}>
												{S(payload[0].payload.month)}: {N(payload[0].value)} cases
											</div>
										) : null
									}
								/>
								<Bar dataKey="cases" fill={t.data} radius={[4, 4, 0, 0]} isAnimationActive={false} />
							</BarChart>
						</ResponsiveContainer>
					)}
				</Card>

				<Card title="Recovery quality by ASA status" description="Number of dogs, median recovery time">
					{recovery.isLoading ? (
						<Skeleton height={120} />
					) : recovery.isError ? (
						<ErrorText error={recovery.error} />
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr>
									<Th>ASA</Th>
									<Th right>Excellent</Th>
									<Th right>Good</Th>
									<Th right>Fair</Th>
									<Th right>Recovery, min</Th>
								</tr>
							</thead>
							<tbody>
								{recoveryRows.map((r) => (
									<tr key={r.asa} style={{ borderTop: `1px solid ${t.border}`, color: t.text }}>
										<td className="py-1.5 pr-2">
											<Badge>ASA {r.asa}</Badge>
										</td>
										<td className="py-1.5 pr-2 text-right">{r.excellent}</td>
										<td className="py-1.5 pr-2 text-right">{r.good}</td>
										<td className="py-1.5 pr-2 text-right">{r.fair}</td>
										<td className="py-1.5 pr-2 text-right">{r.median}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Card>
			</div>

			<Card title="Export for analysis" description="Full study tables as CSV, one row per case, reading, dose, lab result or remark">
				<div className="flex flex-wrap items-center gap-2">
					{EXPORTS.map((e) => (
						<button
							key={e.name}
							type="button"
							onClick={() => runExport(e)}
							className="flex items-center gap-1.5 text-xs px-3 py-1.5"
							style={{ color: t.text, background: t.raised, border: `1px solid ${t.border}`, borderRadius: 8 }}
						>
							<Download size={13} color={t.muted} />
							{e.name}
						</button>
					))}
					{exportStatus ? (
						<span className="text-xs ml-2" style={{ color: t.muted }} role="status">
							{exportStatus}
						</span>
					) : null}
				</div>
			</Card>
		</div>
	);
}

// patient record: pick a dog on the left, see that case's full history on the right
function Patients({
	selected,
	onSelect,
	filter,
	onClearFilter,
}: {
	selected: string | null;
	onSelect: (caseId: string) => void;
	filter: ComplicationKey | null;
	onClearFilter: () => void;
}) {
	const t = useTheme();
	const [search, setSearch] = useState('');
	const [vital, setVital] = useDiveState<VitalKey>('vital', 'map');

	const list = useSQLQuery(PATIENT_LIST_SQL);
	const patients = toPatients(list.data);
	const filterName = filter ? COMPLICATIONS.find((item) => item.key === filter)?.name : null;
	const filtered = patients
		.filter((p) => (filter ? p.flags[filter] : true))
		.filter((p) => `${p.name} ${p.breed}`.toLowerCase().includes(search.trim().toLowerCase()));
	const active = selected && filtered.some((p) => p.caseId === selected) ? selected : (filtered[0]?.caseId ?? selected ?? null);
	const on = { enabled: active != null };
	const where = `case_id = ${quote(active ?? '')}`;
	const spec = VITALS[vital];

	const detail = useSQLQuery(
		`
		SELECT coalesce(p.animal_name, 'Patient ' || c.patient_id) AS animal_name,
			coalesce(p.breed, 'unknown breed') AS breed,
			c.age_years, c.weight_kg, c.physical_status, c.is_emergency, c.sedation_level, c.recumbency,
			c.recovery_quality, c.anesthesia_minutes, c.recovery_minutes, c.pre_op_eval, c.comments,
			strftime(c.procedure_date, '%b %d, %Y') AS procedure_day,
			strftime(c.anesthesia_start, '%H:%M') AS start_time,
			strftime(c.anesthesia_end, '%H:%M') AS end_time,
			(SELECT min(coalesce(ibp_mean_mmhg, nibp_mean_mmhg)) FROM ${DB}."fct_vital_sign" v WHERE v.case_id = c.case_id) AS lowest_map,
			(SELECT min(temperature_f) FROM ${DB}."fct_vital_sign" v WHERE v.case_id = c.case_id) AS lowest_temp
		FROM ${DB}."fct_anesthesia_case" c
		LEFT JOIN ${DB}."dim_patient" p ON p.patient_id = c.patient_id
		WHERE c.${where}
	`,
		on,
	);
	const team = useSQLQuery(
		`
		SELECT cs.role, s.person_name
		FROM ${DB}."fct_case_staff" cs
		LEFT JOIN ${DB}."dim_staff" s ON s.person_id = cs.person_id
		WHERE cs.${where}
		ORDER BY cs.role
	`,
		on,
	);
	const meds = useSQLQuery(
		`
		SELECT drug_name, dose_amount, dose_unit, reason_given
		FROM ${DB}."fct_medication"
		WHERE ${where}
		ORDER BY try_cast(regexp_extract(med_admin_id, 'med_(\\d+)', 1) AS INTEGER), med_admin_id
	`,
		on,
	);
	const labs = useSQLQuery(
		`
		SELECT test_name, result_text, coalesce(unit, '') AS unit
		FROM ${DB}."fct_lab_result"
		WHERE ${where}
		ORDER BY try_cast(regexp_extract(lab_result_id, 'lab_(\\d+)', 1) AS INTEGER), lab_result_id
	`,
		on,
	);
	const remarks = useSQLQuery(
		`
		SELECT strftime(remark_time, '%H:%M') AS remark_at, remark_text
		FROM ${DB}."fct_case_remark"
		WHERE ${where}
		ORDER BY remark_time, try_cast(regexp_extract(remark_id, 'remark_(\\d+)', 1) AS INTEGER)
	`,
		on,
	);
	const study = useStudyVitals();
	const [stats, setStats] = useDiveState<StatKey[]>('tlStats', ['median', 'iqr']);
	const procedures = useSQLQuery(
		`
		SELECT p.procedure_name,
			round(date_diff('second', c.anesthesia_start, p.start_time) / 60.0, 1) AS start_min,
			round(date_diff('second', c.anesthesia_start, p.end_time) / 60.0, 1) AS end_min
		FROM ${DB}."fct_procedure" p
		JOIN ${DB}."fct_anesthesia_case" c ON c.case_id = p.case_id
		WHERE c.${where}
		ORDER BY start_min
	`,
		on,
	);

	const d = (Array.isArray(detail.data) ? detail.data : [])[0];
	const steps = (Array.isArray(procedures.data) ? procedures.data : []).map((r) => ({ name: S(r.procedure_name), start: N(r.start_min), end: N(r.end_min) }));
	// the dog's readings on the study's 5 minute grid, with the study stats at the same buckets
	const own = study.buckets.filter((b) => b.caseId === active && b[vital] != null);
	const dogLast = Math.max(0, ...own.map((b) => b.minute), ...steps.map((st) => st.end));
	const points = d3.range(0, dogLast + 1, 5).map((minute) => {
		const mine = own.find((b) => b.minute === minute);
		const st = study.stats[vital].get(minute);
		return {
			minute,
			value: mine ? (mine[vital] as number) : null,
			...(st ? { mean: st.mean, median: st.median, iqr: st.iqr, range: st.range, n: st.n } : {}),
		};
	});
	const yScale = niceDomain(
		points
			.flatMap((p) => [p.value, ...(stats.includes('range') && p.range ? p.range : []), ...(stats.includes('iqr') && p.iqr ? p.iqr : [])])
			.filter((v): v is number => typeof v === 'number')
			.concat([spec.threshold.value]),
	);
	const xTicks = hourTicks(dogLast);
	const remarkRows = Array.isArray(remarks.data) ? remarks.data : [];

	return (
		<div className="grid gap-4" style={{ gridTemplateColumns: '230px minmax(0, 1fr)' }}>
			<div>
				<Card title="Patients" description={filter ? `${filtered.length} of ${patients.length} dogs` : `${patients.length} dogs, by procedure date`}>
					{filterName ? (
						<button
							type="button"
							onClick={onClearFilter}
							className="flex items-center gap-1.5 text-xs px-2 py-1 mb-2"
							style={{ color: t.danger, background: t.dangerBg, border: `1px solid ${t.dangerEdge}`, borderRadius: 999 }}
							aria-label={`Clear the ${filterName} filter`}
						>
							{filterName} ✕
						</button>
					) : null}
					<label className="flex items-center gap-2 px-2 py-1.5 mb-2" style={{ background: t.raised, border: `1px solid ${t.border}`, borderRadius: 8 }}>
						<Search size={13} color={t.muted} />
						<input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search name or breed"
							className="text-xs w-full outline-none"
							style={{ background: 'transparent', color: t.text }}
							aria-label="Search patients"
						/>
					</label>
					{list.isLoading ? (
						<div className="space-y-2">
							<Skeleton height={34} />
							<Skeleton height={34} />
							<Skeleton height={34} />
						</div>
					) : list.isError ? (
						<ErrorText error={list.error} />
					) : (
						<ul className="space-y-1 pr-1" style={{ maxHeight: 720, ...scrollArea(t) }}>
							{filtered.map((p) => {
								const isActive = p.caseId === active;
								return (
									<li key={p.caseId}>
										<button
											type="button"
											onClick={() => onSelect(p.caseId)}
											aria-pressed={isActive}
											className="w-full text-left px-2 py-1.5 flex items-center justify-between gap-2"
											style={{ background: isActive ? t.accentBg : 'transparent', border: `1px solid ${isActive ? t.accentEdge : 'transparent'}`, borderRadius: 8 }}
										>
											<span style={{ minWidth: 0 }}>
												<span className="block text-sm" style={{ color: t.text }}>
													{p.name}
												</span>
												<span className="block text-xs" style={{ color: t.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
													{p.breed} · {p.day}
												</span>
											</span>
											<span className="text-xs" style={{ color: t.muted }}>
												{p.asa}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</Card>
			</div>

			<div className="space-y-4" style={{ minWidth: 0 }}>
				<Card>
					{detail.isLoading || list.isLoading ? (
						<div className="space-y-2">
							<Skeleton height={26} width="40%" />
							<Skeleton height={16} width="70%" />
						</div>
					) : detail.isError ? (
						<ErrorText error={detail.error} />
					) : d ? (
						<>
							<div className="flex items-start justify-between gap-3">
								<div>
									<h2 className="text-xl font-semibold" style={{ color: t.text }}>
										{S(d.animal_name)}
									</h2>
									<p className="text-xs mt-0.5" style={{ color: t.muted }}>
										{S(d.breed)} · {d.age_years == null ? 'age unknown' : `${N(d.age_years).toFixed(1)} y`} · {d.weight_kg == null ? 'weight unknown' : `${N(d.weight_kg)} kg`} ·{' '}
										{S(d.procedure_day)}, {S(d.start_time)}–{S(d.end_time)}
									</p>
								</div>
								<div className="flex flex-wrap justify-end gap-1.5">
									<Badge>ASA {S(d.physical_status)}</Badge>
									{d.is_emergency ? <Badge tone="danger">emergency</Badge> : null}
									<Badge tone={S(d.recovery_quality) === 'Excellent' ? 'accent' : 'neutral'}>{S(d.recovery_quality)} recovery</Badge>
								</div>
							</div>
							<div className="grid grid-cols-4 gap-3 mt-4">
								{[
									{ icon: Timer, label: 'Anesthesia', value: `${N(d.anesthesia_minutes)} min`, danger: false },
									{ icon: Activity, label: 'Recovery', value: `${N(d.recovery_minutes)} min`, danger: false },
									{ icon: HeartPulse, label: 'Lowest MAP', value: `${N(d.lowest_map)} mmHg`, danger: N(d.lowest_map) < 60 },
									{ icon: Thermometer, label: 'Lowest temp', value: `${N(d.lowest_temp).toFixed(1)} °F`, danger: N(d.lowest_temp) < 97 },
								].map((m) => (
									<div key={m.label} className="p-2.5" style={{ background: t.raised, borderRadius: 10 }}>
										<p className="text-xs flex items-center gap-1" style={{ color: t.muted }}>
											<m.icon size={12} color={t.muted} /> {m.label}
										</p>
										<p className="text-base font-semibold mt-0.5" style={{ color: t.text }}>
											{m.value}
										</p>
										{m.danger ? (
											<p className="text-xs" style={{ color: t.danger }}>
												past threshold
											</p>
										) : null}
									</div>
								))}
							</div>
							<dl className="grid grid-cols-2 gap-x-6 gap-y-2 mt-4 text-xs">
								{[
									['Pre-op evaluation', d.pre_op_eval],
									['Comments', d.comments],
									['Sedation', d.sedation_level],
									['Recumbency', d.recumbency],
								].map(([label, value]) => (
									<div key={S(label)}>
										<dt style={{ color: t.muted }}>{S(label)}</dt>
										<dd style={{ color: t.text }}>{S(value) || '—'}</dd>
									</div>
								))}
							</dl>
						</>
					) : (
						<p className="text-sm" style={{ color: t.muted }}>
							No dogs match
						</p>
					)}
				</Card>

				<Card
					title={`${spec.label} during anesthesia`}
					description={steps.length ? `Shaded: ${steps.map((st) => `${st.name} ${Math.round(st.start)}–${Math.round(st.end)} min`).join(' · ')}` : 'minutes since anesthesia start'}
					action={
						<div className="flex gap-1" role="group" aria-label="Vital sign">
							{VITAL_KEYS.map((key) => (
								<Chip key={key} active={key === vital} onClick={() => setVital(key)}>
									{VITALS[key].short}
								</Chip>
							))}
						</div>
					}
				>
					<div className="flex flex-wrap items-center justify-between gap-3 mb-2">
						<OverlayControls stats={stats} setStats={setStats} />
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: t.muted }}>
							<span className="flex items-center gap-1.5">
								<span style={{ width: 16, height: 3, borderRadius: 2, background: t.data }} />
								<span style={{ color: t.text }}>{d ? S(d.animal_name) : 'this dog'}</span>
							</span>
							<OverlayLegend stats={stats} />
						</div>
					</div>
					{study.query.isLoading || list.isLoading ? (
						<Skeleton height={220} />
					) : study.query.isError ? (
						<ErrorText error={study.query.error} />
					) : (
						<ResponsiveContainer width="100%" height={220}>
							<ComposedChart data={points} margin={{ top: 6, right: 12, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
								{steps.map((step, k) => (
									<ReferenceArea key={step.name + k} x1={step.start} x2={step.end} fill={t.shade} fillOpacity={t.shadeOpacity[k % 2]} strokeOpacity={0} ifOverflow="extendDomain" />
								))}
								<ReferenceLine
									y={spec.threshold.value}
									stroke={t.danger}
									strokeDasharray="4 4"
									ifOverflow="extendDomain"
									label={{ value: spec.threshold.label, position: 'insideTopRight', fontSize: 10, fill: t.muted }}
								/>
								<XAxis dataKey="minute" type="number" domain={[0, xTicks[xTicks.length - 1]]} ticks={xTicks} fontSize={11} stroke={t.muted} tickLine={false} />
								<YAxis domain={yScale.domain()} ticks={yScale.ticks(5)} fontSize={11} stroke={t.muted} tickLine={false} axisLine={false} />
								{overlayLayers(t, stats)}
								<Tooltip
									cursor={{ stroke: t.muted, strokeDasharray: '3 3' }}
									content={({ active: on2, payload, label }) => {
										const row = on2 && payload && payload[0] ? (payload[0].payload as Record<string, unknown>) : null;
										return row ? (
											<div style={tooltipBox(t)}>
												<p style={{ color: t.muted }}>
													{Number(label).toFixed(0)}–{Number(label) + 5} min since start
												</p>
												<p>
													{d ? S(d.animal_name) : 'This dog'} {typeof row.value === 'number' ? `${Number(row.value.toFixed(1))} ${spec.unit}` : '—'}
												</p>
												<OverlayTooltipLines row={row} stats={stats} unit={spec.unit} />
											</div>
										) : null;
									}}
								/>
								<Line type="linear" dataKey="value" stroke={t.data} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
							</ComposedChart>
						</ResponsiveContainer>
					)}
				</Card>

				<div className="grid grid-cols-2 gap-4">
					<Card title="Medications given" description="In order of administration">
						{meds.isLoading ? (
							<Skeleton height={140} />
						) : meds.isError ? (
							<ErrorText error={meds.error} />
						) : (
							<table className="w-full text-xs">
								<thead>
									<tr>
										<Th>Drug</Th>
										<Th right>Dose</Th>
										<Th>Reason</Th>
									</tr>
								</thead>
								<tbody>
									{(Array.isArray(meds.data) ? meds.data : []).map((r, k) => (
										<tr key={k} style={{ borderTop: `1px solid ${t.border}`, color: t.text }}>
											<td className="py-1 pr-2">{S(r.drug_name)}</td>
											<td className="py-1 pr-2 text-right whitespace-nowrap">{r.dose_amount == null ? '—' : `${N(r.dose_amount)} ${S(r.dose_unit)}`}</td>
											<td className="py-1" style={{ color: t.muted }}>
												{S(r.reason_given)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</Card>

					<div className="space-y-4">
						<Card title="Pre-op labs">
							{labs.isLoading ? (
								<Skeleton height={120} />
							) : labs.isError ? (
								<ErrorText error={labs.error} />
							) : (
								<table className="w-full text-xs">
									<tbody>
										{(Array.isArray(labs.data) ? labs.data : []).map((r, k) => (
											<tr key={k} style={{ borderTop: k ? `1px solid ${t.border}` : undefined, color: t.text }}>
												<td className="py-1 pr-2" style={{ color: t.muted }}>
													{S(r.test_name)}
												</td>
												<td className="py-1 text-right">
													{S(r.result_text)} {S(r.unit)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Card>
						<Card title="Care team">
							{team.isLoading ? (
								<Skeleton height={80} />
							) : team.isError ? (
								<ErrorText error={team.error} />
							) : (
								<ul className="space-y-1 text-xs">
									{(Array.isArray(team.data) ? team.data : []).map((r, k) => (
										<li key={k} className="flex justify-between gap-2">
											<span style={{ color: t.muted }}>{S(r.role)}</span>
											<span style={{ color: t.text }}>{S(r.person_name)}</span>
										</li>
									))}
								</ul>
							)}
						</Card>
					</div>
				</div>

				<Card title="Case remarks" description={remarks.isLoading ? 'Loading' : `${remarkRows.length} timestamped notes from the anesthesia record`}>
					{remarks.isLoading ? (
						<Skeleton height={160} />
					) : remarks.isError ? (
						<ErrorText error={remarks.error} />
					) : (
						<div style={{ maxHeight: 300, ...scrollArea(t) }}>
							<table className="w-full text-xs">
								<thead>
									<tr>
										<Th>Time</Th>
										<Th>Remark</Th>
									</tr>
								</thead>
								<tbody>
									{remarkRows.map((r, k) => (
										<tr key={k} style={{ borderTop: `1px solid ${t.border}`, color: t.text }}>
											<td className="py-1 pr-3 whitespace-nowrap" style={{ color: t.muted, width: 56 }}>
												{S(r.remark_at)}
											</td>
											<td className="py-1">{S(r.remark_text)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			</div>
		</div>
	);
}

// vitals timeline: the picked dogs on a shared minutes since start axis, one chart
// per picked vital, with overlays computed across every dog in the study
function Timeline() {
	const t = useTheme();
	const [vitals, setVitals] = useDiveState<VitalKey[]>('tlVitals', ['map', 'hr']);
	const [picked, setPicked] = useDiveState<string[]>('tlPatients', []);
	const [stats, setStats] = useDiveState<StatKey[]>('tlStats', ['median', 'iqr']);

	const list = useSQLQuery(PATIENT_LIST_SQL);
	const patients = toPatients(list.data);
	const study = useStudyVitals();

	const shown = picked.length ? patients.filter((p) => picked.includes(p.caseId)) : patients;
	const colored = shown.length <= t.series.length;
	const colorOf = (i: number) => (colored ? t.series[i] : t.muted);
	const shownKey = shown.map((p) => p.caseId).join(',');

	const charts = useMemo(() => {
		const ids = new Set(shown.map((p) => p.caseId));
		const lastMinute = d3.max(study.buckets.filter((b) => ids.has(b.caseId)).map((b) => b.minute)) ?? 60;
		const minutes = d3.range(0, lastMinute + 1, 5);
		return vitals.map((key) => {
			const byMinute = new Map<number, Record<string, unknown>>(minutes.map((m) => [m, { minute: m }]));
			for (const b of study.buckets) {
				if (!ids.has(b.caseId) || b[key] == null) continue;
				const slot = byMinute.get(b.minute);
				if (slot) slot[b.caseId] = b[key];
			}
			const data = minutes.map((m) => {
				const st = study.stats[key].get(m);
				return { ...byMinute.get(m)!, ...(st ? { mean: st.mean, median: st.median, iqr: st.iqr, range: st.range, n: st.n } : {}) };
			});
			const values = data
				.flatMap((row) => [
					...shown.map((p) => row[p.caseId]),
					...(stats.includes('range') && Array.isArray(row.range) ? row.range : []),
					...(stats.includes('iqr') && Array.isArray(row.iqr) ? row.iqr : []),
				])
				.filter((v): v is number => typeof v === 'number');
			const lastIndex = Object.fromEntries(shown.map((p) => [p.caseId, data.reduce((last, row, i) => (typeof row[p.caseId] === 'number' ? i : last), -1)]));
			return { key, data, yScale: niceDomain(values.concat([VITALS[key].threshold.value])), lastIndex };
		});
	}, [study.buckets, study.stats, vitals, shownKey, stats.join(',')]);

	const lastMinute = d3.max(charts.flatMap((c) => c.data.map((row) => N(row.minute)))) ?? 60;
	const xTicks = hourTicks(lastMinute);
	const height = vitals.length === 1 ? 420 : 250;

	return (
		<div className="space-y-4">
			<Card>
				<div className="flex flex-wrap items-center gap-3">
					<MultiSelect
						label="Vitals"
						options={VITAL_KEYS.map((key) => ({ value: key, label: VITALS[key].label, hint: VITALS[key].unit }))}
						value={vitals}
						onChange={(next) => setVitals(next as VitalKey[])}
						emptyLabel="None"
						allowEmpty={false}
					/>
					<MultiSelect
						label="Patients"
						options={patients.map((p) => ({ value: p.caseId, label: p.name, hint: p.breed }))}
						value={picked}
						onChange={setPicked}
						emptyLabel="All dogs"
						allowEmpty
					/>
					<OverlayControls stats={stats} setStats={setStats} />
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs" style={{ color: t.muted }}>
					{colored ? (
						shown.map((p, i) => (
							<span key={p.caseId} className="flex items-center gap-1.5">
								<span style={{ width: 14, height: 3, borderRadius: 2, background: colorOf(i) }} />
								<span style={{ color: t.text }}>{p.name}</span>
							</span>
						))
					) : (
						<span className="flex items-center gap-1.5">
							<span style={{ width: 14, height: 2, background: t.muted, opacity: 0.6 }} />
							{shown.length} dogs, one thin line each, pick 6 or fewer to color them
						</span>
					)}
					<OverlayLegend stats={stats} />
					<span>· study overlays always use all {patients.length || 20} dogs, in 5 minute buckets with at least 3 dogs</span>
				</div>
			</Card>

			{study.query.isLoading || list.isLoading
				? vitals.map((key) => (
						<Card key={key} title={VITALS[key].label}>
							<Skeleton height={height} />
						</Card>
					))
				: study.query.isError
					? [<ErrorText key="e" error={study.query.error} />]
					: charts.map((chart) => {
							const spec = VITALS[chart.key];
							return (
								<Card key={chart.key} title={`${spec.label}, ${spec.unit}`} description="minutes since anesthesia start">
									<ResponsiveContainer width="100%" height={height}>
										<ComposedChart data={chart.data} margin={{ top: 6, right: colored ? 72 : 16, bottom: 0, left: -12 }}>
											<CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
											<ReferenceLine
												y={spec.threshold.value}
												stroke={t.muted}
												strokeDasharray="2 4"
												ifOverflow="extendDomain"
												label={{ value: spec.threshold.label, position: 'insideBottomLeft', fontSize: 10, fill: t.muted }}
											/>
											<XAxis dataKey="minute" type="number" domain={[0, xTicks[xTicks.length - 1]]} ticks={xTicks} fontSize={11} stroke={t.muted} tickLine={false} />
											<YAxis domain={chart.yScale.domain()} ticks={chart.yScale.ticks(5)} fontSize={11} stroke={t.muted} tickLine={false} axisLine={false} />
											{stats.includes('range') ? <Area dataKey="range" type="linear" stroke="none" fill={t.text} fillOpacity={0.07} isAnimationActive={false} /> : null}
											{stats.includes('iqr') ? <Area dataKey="iqr" type="linear" stroke="none" fill={t.text} fillOpacity={0.14} isAnimationActive={false} /> : null}
											{shown.map((p, i) => (
												<Line
													key={p.caseId}
													dataKey={p.caseId}
													name={p.name}
													type="linear"
													stroke={colorOf(i)}
													strokeWidth={colored ? 2 : 1}
													strokeOpacity={colored ? 1 : 0.35}
													dot={false}
													connectNulls
													isAnimationActive={false}
													label={
														colored
															? (props: { x?: number; y?: number; index?: number }) =>
																	props.index === chart.lastIndex[p.caseId] ? (
																		<text x={N(props.x) + 6} y={N(props.y) + 4} fontSize={10} fill={t.muted}>
																			{p.name}
																		</text>
																	) : (
																		<g />
																	)
															: false
													}
												/>
											))}
											{stats.includes('mean') ? <Line dataKey="mean" type="linear" stroke={t.text} strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} /> : null}
											{stats.includes('median') ? (
												<Line dataKey="median" type="linear" stroke={t.text} strokeWidth={2.5} strokeDasharray="6 4" dot={false} connectNulls isAnimationActive={false} />
											) : null}
											<Tooltip
												cursor={{ stroke: t.muted, strokeDasharray: '3 3' }}
												content={({ active, payload, label }) => {
													const row = active && payload && payload[0] ? (payload[0].payload as Record<string, unknown>) : null;
													if (!row) return null;
													const fmt = (v: unknown) => (typeof v === 'number' ? `${Number(v.toFixed(1))} ${spec.unit}` : '—');
													return (
														<div style={tooltipBox(t)}>
															<p style={{ color: t.muted }}>
																{Number(label).toFixed(0)}–{Number(label) + 5} min · study n {N(row.n)}
															</p>
															<OverlayTooltipLines row={row} stats={stats} unit={spec.unit} />
															{colored
																? shown.map((p, i) => (
																		<p key={p.caseId} className="flex items-center gap-1.5">
																			<span style={{ width: 8, height: 8, borderRadius: 4, background: colorOf(i) }} />
																			{p.name} {fmt(row[p.caseId])}
																		</p>
																	))
																: null}
														</div>
													);
												}}
											/>
										</ComposedChart>
									</ResponsiveContainer>
								</Card>
							);
						})}
		</div>
	);
}

const TABS = [
	{ key: 'patients', label: 'Patients', icon: PawPrint },
	{ key: 'overview', label: 'Study overview', icon: LayoutDashboard },
	{ key: 'timeline', label: 'Vitals timeline', icon: LineChartIcon },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function AnesthesiaStudyDashboard() {
	const [mode, setMode] = useDiveState<'dark' | 'light'>('theme', 'dark');
	const [tab, setTab] = useDiveState<TabKey>('tab', 'patients');
	const [selected, setSelected] = useDiveState<string | null>('case', null);
	const [filter, setFilter] = useDiveState<ComplicationKey | null>('complication', null);
	const t = THEMES[mode];
	const drill = (key: ComplicationKey) => {
		setFilter(key);
		setSelected(undefined);
		setTab('patients');
	};

	return (
		<ThemeContext.Provider value={t}>
			<main className="p-5 min-h-screen" style={{ background: t.bg, color: t.text, colorScheme: t.scheme }}>
				<div className="flex items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-semibold" style={{ color: t.text }}>
							Anesthesia study
						</h1>
						<p className="text-sm" style={{ color: t.muted }}>
							Canine orthopedic cases, one row per surgery · dummy data
						</p>
					</div>
					<button
						type="button"
						onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
						aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
						className="flex items-center gap-1.5 text-xs px-3 py-1.5"
						style={{ color: t.text, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 9 }}
					>
						{mode === 'dark' ? <Sun size={14} color={t.muted} /> : <Moon size={14} color={t.muted} />}
						{mode === 'dark' ? 'Light mode' : 'Dark mode'}
					</button>
				</div>

				<nav className="flex gap-1 mt-4 mb-5" role="tablist" aria-label="Dashboard sections" style={{ borderBottom: `1px solid ${t.border}` }}>
					{TABS.map(({ key, label, icon: Icon }) => {
						const isActive = tab === key;
						return (
							<button
								key={key}
								type="button"
								role="tab"
								aria-selected={isActive}
								onClick={() => setTab(key)}
								className="flex items-center gap-2 text-sm font-medium px-4 py-2.5"
								style={{
									color: isActive ? t.text : t.muted,
									borderBottom: `2px solid ${isActive ? t.accent : 'transparent'}`,
									marginBottom: -1,
								}}
							>
								<Icon size={16} color={isActive ? t.accent : t.muted} />
								{label}
							</button>
						);
					})}
				</nav>

				{tab === 'overview' ? (
					<Overview onDrill={drill} />
				) : tab === 'patients' ? (
					<Patients selected={selected} onSelect={setSelected} filter={filter} onClearFilter={() => setFilter(undefined)} />
				) : (
					<Timeline />
				)}
			</main>
		</ThemeContext.Provider>
	);
}

