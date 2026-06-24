import { ArtifactStore } from "../../files/artifact-store.js";

export interface DirectMultipartFile {
	buffer: Buffer;
	filename: string;
	contentType?: string;
}

export interface DirectApiFileMetadata {
	id: string;
	name: string;
	mimetype: string;
	size: number;
	downloadUrl: string;
}

export interface DirectApiAudioAttachment {
	buffer: Buffer;
	mimeType: string;
}

export interface DirectApiAttachmentIngestResult {
	files: DirectApiFileMetadata[];
	audioAttachments: DirectApiAudioAttachment[];
}

function isAudioMimeType(mimeType: string | undefined): boolean {
	return (
		!!mimeType &&
		(mimeType.startsWith("audio/") || mimeType === "application/ogg")
	);
}

export async function ingestDirectMultipartFiles(
	files: DirectMultipartFile[] | undefined,
	publicGatewayUrl: string,
	artifactStore = new ArtifactStore(),
): Promise<DirectApiAttachmentIngestResult> {
	if (!files?.length) return { files: [], audioAttachments: [] };

	const publishedFiles: DirectApiFileMetadata[] = [];
	const audioAttachments: DirectApiAudioAttachment[] = [];
	for (const file of files) {
		const published = await artifactStore.publish({
			buffer: file.buffer,
			filename: file.filename,
			contentType: file.contentType,
			publicGatewayUrl,
		});
		publishedFiles.push({
			id: published.artifactId,
			name: published.filename,
			mimetype: published.contentType,
			size: published.size,
			downloadUrl: published.downloadUrl,
		});
		if (isAudioMimeType(published.contentType)) {
			audioAttachments.push({
				buffer: file.buffer,
				mimeType: published.contentType,
			});
		}
	}

	return { files: publishedFiles, audioAttachments };
}
