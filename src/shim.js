import { useEffect, useState } from 'react';
import * as duckdb from '@duckdb/duckdb-wasm';

// the dive's SQL points at the MotherDuck database name, the static build
// attaches the exported file under this alias instead
const MD_DB = '"tabsdata_animal_research"."main"';
const LOCAL_DB = '"anesthesia"."main"';
const DB_FILE = `${import.meta.env.BASE_URL}data/anesthesia.duckdb`;

const toLocalSql = (sql) => sql.replaceAll(MD_DB, LOCAL_DB);

// one shared connection, opened the first time any query runs
let connPromise = null;
function getConnection() {
	if (!connPromise) {
		connPromise = (async () => {
			const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
			const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
				const worker = new Worker(workerUrl);
			const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
			await db.instantiate(bundle.mainModule);
			const url = new URL(DB_FILE, window.location.href).href;
			await db.registerFileURL('anesthesia.duckdb', url, duckdb.DuckDBDataProtocol.HTTP, false);
			const conn = await db.connect();
			await conn.query(`ATTACH 'anesthesia.duckdb' AS anesthesia (READ_ONLY)`);
			return conn;
		})();
	}
	return connPromise;
}

async function runRows(sql) {
	const conn = await getConnection();
	const table = await conn.query(toLocalSql(sql));
	return table.toArray().map((row) => row.toJSON());
}

// same shape the dive reads from @motherduck/react-sql-query: { data, error, isLoading }
export function useSQLQuery(sql) {
	const [state, setState] = useState({ data: undefined, error: null, isLoading: true });
	useEffect(() => {
		let live = true;
		setState({ data: undefined, error: null, isLoading: true });
		runRows(sql)
			.then((data) => live && setState({ data, error: null, isLoading: false }))
			.catch((error) => {
				console.error("query failed", error);
				if (live) setState({ data: undefined, error, isLoading: false });
			});
		return () => {
			live = false;
		};
	}, [sql]);
	return state;
}

// keeps the dive's useState-style setter, values live only in the page
export function useDiveState(key, initial) {
	return useState(initial);
}

// runs the query in the browser and downloads the result as CSV
export function useExport() {
	const exportQuery = async ({ sql, filename }) => {
		const rows = await runRows(sql);
		const cols = rows.length ? Object.keys(rows[0]) : [];
		const esc = (v) => {
			if (v == null) return '';
			const s = String(v);
			return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
		};
		const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = filename || 'export.csv';
		a.click();
		URL.revokeObjectURL(url);
	};
	return { exportQuery };
}
