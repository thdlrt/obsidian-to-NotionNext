import { TFile, requestUrl } from "obsidian";
import type MyPlugin from "src/main";
import type { DatabaseDetails } from "../../ui/settingTabs";

const NOTION_API_VERSION = "2025-09-03";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const AUTO_COMPRESSIBLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);

interface PreparedUploadPayload {
	id: string;
	filename: string;
	binary: ArrayBuffer;
	contentType: string;
}

interface FileUploadSession {
	id: string;
	status: string;
	upload_url?: string;
}

interface UploadResult {
	id: string;
	filename: string;
}

export class AttachmentUploader {
	private plugin: MyPlugin;
	private dbDetails: DatabaseDetails;
	private textEncoder = new TextEncoder();

	constructor(plugin: MyPlugin, dbDetails: DatabaseDetails) {
		this.plugin = plugin;
		this.dbDetails = dbDetails;
	}

	async uploadFile(file: TFile): Promise<UploadResult> {
		const { notionAPI } = this.dbDetails;
		const fileSizeBytes = file.stat?.size ?? 0;
		const mode = "single_part";

		console.log(`[AttachmentUploader] uploadFile: ${file.name}`, {
			path: file.path,
			size: `${(fileSizeBytes / 1024).toFixed(2)} KB`,
			contentType: this.getContentType(file.extension),
			mode,
		});

		const session = await this.createUploadSession({
			mode,
			notionAPI,
		});

		console.log(`[AttachmentUploader] Upload session created:`, {
			sessionId: session.id,
			status: session.status,
		});

		const binary = await this.plugin.app.vault.readBinary(file);
		const payload = await this.prepareUploadPayload(binary, file.name, file.extension, file.path);
		console.log(`[AttachmentUploader] Prepared binary data: ${payload.binary.byteLength} bytes`, {
			filename: payload.filename,
			contentType: payload.contentType,
		});

		const uploadUrl =
			session.upload_url ??
			`https://api.notion.com/v1/file_uploads/${encodeURIComponent(session.id)}/send`;
		await this.sendFileData(session.id, uploadUrl, payload.binary, notionAPI, payload.filename, payload.contentType);

		console.log(`[AttachmentUploader] Upload complete: ${file.name} -> ${session.id}`);
		return { id: session.id, filename: payload.filename };
	}

	async uploadBuffer(binary: ArrayBuffer, filename: string, extension: string): Promise<UploadResult> {
		const { notionAPI } = this.dbDetails;
		const payload = await this.prepareUploadPayload(binary, filename, extension, filename);

		const mode = "single_part";
		console.log(`[AttachmentUploader] uploadBuffer: ${filename}`, {
			size: `${(payload.binary.byteLength / 1024).toFixed(2)} KB`,
			contentType: payload.contentType,
			mode,
		});

		const session = await this.createUploadSession({ mode, notionAPI });
		console.log(`[AttachmentUploader] Upload session created for buffer:`, {
			sessionId: session.id,
			status: session.status,
		});

		const uploadUrl =
			session.upload_url ??
			`https://api.notion.com/v1/file_uploads/${encodeURIComponent(session.id)}/send`;
		await this.sendFileData(session.id, uploadUrl, payload.binary, notionAPI, payload.filename, payload.contentType);

		console.log(`[AttachmentUploader] Buffer upload complete: ${filename} -> ${session.id}`);
		return { id: session.id, filename: payload.filename };
	}

	private async prepareUploadPayload(
		binary: ArrayBuffer,
		filename: string,
		extension: string,
		sourceLabel: string,
	): Promise<PreparedUploadPayload> {
		const normalizedExtension = extension.toLowerCase();
		if (binary.byteLength <= MAX_UPLOAD_BYTES) {
			return {
				id: sourceLabel,
				filename,
				binary,
				contentType: this.getContentType(normalizedExtension),
			};
		}

		if (!AUTO_COMPRESSIBLE_IMAGE_EXTENSIONS.has(normalizedExtension)) {
			throw new Error(
				`File too large for Notion upload (max 5MB): ${sourceLabel} (${(binary.byteLength / 1024 / 1024).toFixed(2)} MB)`,
			);
		}

		if (!this.plugin.settings.autoCompressOversizedImages) {
			throw new Error(
				`Image exceeds Notion upload limit and auto-compression is disabled: ${sourceLabel} (${(binary.byteLength / 1024 / 1024).toFixed(2)} MB)`,
			);
		}

		console.warn(`[AttachmentUploader] Image exceeds 5MB, attempting compression`, {
			source: sourceLabel,
			originalSizeMB: (binary.byteLength / 1024 / 1024).toFixed(2),
			extension: normalizedExtension,
		});

		const compressed = await this.compressImageToFit(binary, normalizedExtension, filename);
		if (compressed.binary.byteLength > MAX_UPLOAD_BYTES) {
			throw new Error(
				`Compressed image is still too large for Notion upload (max 5MB): ${sourceLabel} (${(compressed.binary.byteLength / 1024 / 1024).toFixed(2)} MB)`,
			);
		}

		console.log(`[AttachmentUploader] Image compressed successfully`, {
			source: sourceLabel,
			outputFilename: compressed.filename,
			compressedSizeMB: (compressed.binary.byteLength / 1024 / 1024).toFixed(2),
			contentType: compressed.contentType,
		});

		return {
			id: sourceLabel,
			filename: compressed.filename,
			binary: compressed.binary,
			contentType: compressed.contentType,
		};
	}

	private async compressImageToFit(
		binary: ArrayBuffer,
		extension: string,
		filename: string,
	): Promise<{ binary: ArrayBuffer; filename: string; contentType: string }> {
		const sourceMime = this.getContentType(extension);
		const image = await this.loadImage(binary, sourceMime);
		const baseName = filename.replace(/\.[^.]+$/, "") || "image";
		const targetType = "image/webp";
		const targetExtension = "webp";

		const scales = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25];
		const qualities = [0.92, 0.86, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4];

		let best: Blob | null = null;
		let bestSize = Number.POSITIVE_INFINITY;

		for (const scale of scales) {
			const width = Math.max(1, Math.round(image.width * scale));
			const height = Math.max(1, Math.round(image.height * scale));

			for (const quality of qualities) {
				const blob = await this.renderImageBlob(image, width, height, targetType, quality);
				if (blob.size < bestSize) {
					best = blob;
					bestSize = blob.size;
				}

				if (blob.size <= MAX_UPLOAD_BYTES) {
					return {
						binary: await blob.arrayBuffer(),
						filename: `${baseName}.${targetExtension}`,
						contentType: targetType,
					};
				}
			}
		}

		if (!best) {
			throw new Error(`Failed to compress image: ${filename}`);
		}

		return {
			binary: await best.arrayBuffer(),
			filename: `${baseName}.${targetExtension}`,
			contentType: targetType,
		};
	}

	private async loadImage(binary: ArrayBuffer, contentType: string): Promise<HTMLImageElement> {
		const blob = new Blob([binary], { type: contentType || "application/octet-stream" });
		const objectUrl = URL.createObjectURL(blob);

		try {
			const image = await new Promise<HTMLImageElement>((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error("Failed to decode image for compression"));
				img.src = objectUrl;
			});
			return image;
		} finally {
			URL.revokeObjectURL(objectUrl);
		}
	}

	private async renderImageBlob(
		image: HTMLImageElement,
		width: number,
		height: number,
		contentType: string,
		quality: number,
	): Promise<Blob> {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Failed to create canvas context for image compression");
		}

		context.drawImage(image, 0, 0, width, height);

		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (!blob) {
					reject(new Error("Canvas compression returned empty blob"));
					return;
				}
				resolve(blob);
			}, contentType, quality);
		});
	}

	private async createUploadSession(params: {
		mode: string;
		notionAPI: string;
	}): Promise<FileUploadSession> {
		console.log(`[AttachmentUploader] Creating upload session:`, {
			mode: params.mode,
		});

		const response = await this.requestWithRetry({
			url: "https://api.notion.com/v1/file_uploads",
			method: "POST",
			headers: {
				accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${params.notionAPI}`,
				"Notion-Version": NOTION_API_VERSION,
			},
			body: JSON.stringify({
				mode: params.mode,
			}),
			throw: false,
		});

		const data = response.json;
		if (response.status < 200 || response.status >= 300) {
			console.error(`[AttachmentUploader] Failed to create upload session:`, {
				status: response.status,
				message: data?.message,
				response: data,
			});
			throw new Error(`Failed to create upload session: ${data?.message ?? response.status}`);
		}

		const id = data?.id ?? data?.file_upload?.id;
		if (!id) {
			throw new Error("Upload session response missing id");
		}

		return { id, status: data.status, upload_url: data.upload_url };
	}

	private async sendFileData(
		fileUploadId: string,
		uploadUrl: string,
		binary: ArrayBuffer,
		notionAPI: string,
		filename: string,
		contentType: string,
	): Promise<void> {
		console.log(`[AttachmentUploader] Sending file data for session: ${fileUploadId} (${binary.byteLength} bytes)`);

		const { body, boundary } = this.buildMultipartBody({
			fieldName: "file",
			filename,
			contentType: contentType || "application/octet-stream",
			binary,
		});

		const response = await this.requestWithRetry({
			url: uploadUrl,
			method: "POST",
			headers: {
				accept: "application/json",
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
				Authorization: `Bearer ${notionAPI}`,
				"Notion-Version": NOTION_API_VERSION,
			},
			body,
			throw: false,
		});

		const data = response.json;
		if (response.status < 200 || response.status >= 300) {
			console.error(`[AttachmentUploader] Failed to send file data:`, {
				sessionId: fileUploadId,
				status: response.status,
				message: data?.message,
				response: data,
			});
			throw new Error(`Failed to send file data: ${data?.message ?? response.status}`);
		}

		console.log(`[AttachmentUploader] File data sent successfully for session: ${fileUploadId}`);
	}

	private buildMultipartBody(params: {
		fieldName: string;
		filename: string;
		contentType: string;
		binary: ArrayBuffer;
	}): { body: ArrayBuffer; boundary: string } {
		const boundary = `----NotionFormBoundary${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;

		const safeFilename = params.filename.replace(/"/g, '\\"');
		const prefix = [
			`--${boundary}\r\n`,
			`Content-Disposition: form-data; name="${params.fieldName}"; filename="${safeFilename}"\r\n`,
			`Content-Type: ${params.contentType}\r\n`,
			`\r\n`,
		].join("");
		const suffix = `\r\n--${boundary}--\r\n`;

		const prefixBytes = this.textEncoder.encode(prefix);
		const fileBytes = new Uint8Array(params.binary);
		const suffixBytes = this.textEncoder.encode(suffix);

		const out = new Uint8Array(prefixBytes.length + fileBytes.length + suffixBytes.length);
		out.set(prefixBytes, 0);
		out.set(fileBytes, prefixBytes.length);
		out.set(suffixBytes, prefixBytes.length + fileBytes.length);
		return { body: out.buffer, boundary };
	}

	private async requestWithRetry(params: any, maxAttempts = 4): Promise<any> {
		let attempt = 0;
		let lastError: unknown;

		while (attempt < maxAttempts) {
			attempt++;
			try {
				const response = await requestUrl(params);
				if (this.shouldRetry(response.status) && attempt < maxAttempts) {
					const delayMs = this.getRetryDelay(response, attempt);
					console.warn(`[AttachmentUploader] Retryable status ${response.status}, attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms`);
					await this.sleep(delayMs);
					continue;
				}
				return response;
			} catch (error: unknown) {
				lastError = error;
				console.error(`[AttachmentUploader] Request failed, attempt ${attempt}/${maxAttempts}:`, error);
				if (attempt >= maxAttempts) break;
				const delayMs = this.getRetryDelay(undefined, attempt);
				console.warn(`[AttachmentUploader] Retrying in ${delayMs}ms`);
				await this.sleep(delayMs);
			}
		}

		console.error(`[AttachmentUploader] Request failed after ${maxAttempts} attempts`);
		throw lastError ?? new Error("Request failed after retries");
	}

	private shouldRetry(status: number): boolean {
		return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
	}

	private getRetryDelay(response: any, attempt: number): number {
		const retryAfter = response?.headers?.["retry-after"] ?? response?.headers?.["Retry-After"];
		if (retryAfter) {
			const seconds = parseInt(retryAfter, 10);
			if (!isNaN(seconds)) return seconds * 1000;
		}
		const base = 500;
		const max = 8000;
		const expo = Math.min(max, base * Math.pow(2, attempt - 1));
		const jitter = Math.floor(Math.random() * 250);
		return expo + jitter;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private getContentType(extension: string): string {
		const ext = extension.toLowerCase();
		const mimeTypes: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			svg: "image/svg+xml",
			heic: "image/heic",
			tif: "image/tiff",
			tiff: "image/tiff",
			bmp: "image/bmp",
			pdf: "application/pdf",
		};
		return mimeTypes[ext] ?? "application/octet-stream";
	}
}
