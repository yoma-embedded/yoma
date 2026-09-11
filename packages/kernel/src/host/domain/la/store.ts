/**
 * 采集的落盘布局与进程内缓存 —— `la` 工具与 kernel 的 la.view / la.captures 共用这一份。
 *
 * 布局(<工程>/.yoma/la/<id>/):capture.dsl(DSView 原生)、capture.json(归一化元数据)、
 * decode.ndjson + decode.json(最近一次解码)。目录就是索引,没有别的状态文件。
 *
 * 缓存按目录 LRU 留 3 个:位面 16 通道 × 16M 采样是 32 MB,边沿列表与注解对象再各几到几十 MB,
 * 工具和 RPC 在同一个内核进程里,从前各存一份等于双倍。decode.ndjson 的 mtime 变了就丢注解缓存
 * (重新 decode 会改写它)。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type AnnotationSet, readAnnotationFile } from "./annotations.ts";
import { DslFile, type EdgeList } from "./dsl.ts";

export const LA_DIR = path.join(".yoma", "la");
export const CAPTURE_DSL = "capture.dsl";
export const CAPTURE_JSON = "capture.json";
export const DECODE_NDJSON = "decode.ndjson";
export const DECODE_JSON = "decode.json";

/** capture.json 的内容,也是 la.captures 回给前端的形状。 */
export interface LaCaptureMeta {
	id: string;
	dir: string;
	samplerate: number;
	samples: number;
	durationMs: number;
	channels: { index: number; name: string }[];
	triggerPos?: number;
	source: "capture" | "import" | "demo";
	createdAt: number;
	/** 最近一次解码的实例名;没解码过为空 */
	decoded: string[];
}

export interface OpenedCapture {
	dir: string;
	dsl: DslFile;
	edges(index: number): EdgeList;
	/** 没解码过返回 undefined */
	annotations(): Promise<AnnotationSet | undefined>;
}

const MAX_OPEN = 3;

async function mtimeOf(file: string): Promise<number> {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return 0;
	}
}

class Opened implements OpenedCapture {
	private readonly edgeCache = new Map<number, EdgeList>();
	private ann?: AnnotationSet;
	private annMtime = 0;
	lastUsed = Date.now();

	constructor(readonly dir: string, readonly dsl: DslFile) {}

	edges(index: number): EdgeList {
		let e = this.edgeCache.get(index);
		if (!e) {
			e = this.dsl.edges(index);
			this.edgeCache.set(index, e);
		}
		return e;
	}

	async annotations(): Promise<AnnotationSet | undefined> {
		const file = path.join(this.dir, DECODE_NDJSON);
		const mtime = await mtimeOf(file);
		if (mtime === 0) return undefined;
		if (!this.ann || mtime !== this.annMtime) {
			this.ann = await readAnnotationFile(file);
			this.annMtime = mtime;
		}
		return this.ann;
	}

	/** 重新解码后调用:下一次 annotations() 必定重读。 */
	invalidateAnnotations(): void {
		this.ann = undefined;
		this.annMtime = 0;
	}
}

export class CaptureStore {
	private readonly open_ = new Map<string, Opened>();

	async open(dir: string): Promise<OpenedCapture> {
		const key = path.resolve(dir);
		let hit = this.open_.get(key);
		if (!hit) {
			hit = new Opened(key, await DslFile.open(path.join(key, CAPTURE_DSL)));
			this.open_.set(key, hit);
			if (this.open_.size > MAX_OPEN) {
				const oldest = [...this.open_.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
				if (oldest) this.open_.delete(oldest.dir);
			}
		}
		hit.lastUsed = Date.now();
		return hit;
	}

	/** 写过 decode.ndjson 之后叫一声,省得等 mtime。 */
	invalidate(dir: string): void {
		this.open_.get(path.resolve(dir))?.invalidateAnnotations();
	}

	/** 列 <工程>/.yoma/la 下的采集,最新在前。目录里没有 capture.json 的不算。 */
	async list(projectDir: string): Promise<LaCaptureMeta[]> {
		const root = path.join(projectDir, LA_DIR);
		let ids: string[] = [];
		try {
			ids = await readdir(root);
		} catch {
			return [];
		}
		const out: LaCaptureMeta[] = [];
		for (const id of ids) {
			const dir = path.join(root, id);
			try {
				const meta = JSON.parse(await readFile(path.join(dir, CAPTURE_JSON), "utf8")) as Omit<LaCaptureMeta, "decoded" | "dir">;
				let decoded: string[] = [];
				try {
					const d = JSON.parse(await readFile(path.join(dir, DECODE_JSON), "utf8")) as { pds?: string[] };
					decoded = (d.pds ?? []).map((p) => p.split("=")[0] ?? p);
				} catch {
					// 没解码过
				}
				out.push({ ...meta, dir, decoded });
			} catch {
				// 不是采集目录
			}
		}
		return out.sort((a, b) => b.createdAt - a.createdAt);
	}
}

/** 进程内唯一的一份:工具与 RPC 共用。测试想隔离就自己 new 一个传进去。 */
export const captureStore = new CaptureStore();
