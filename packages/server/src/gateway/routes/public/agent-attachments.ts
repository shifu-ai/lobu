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

export async function ingestDirectMultipartFiles(
	files: DirectMultipartFile[] | undefined,
	publicGatewayUrl: string,
	artifactStore = new ArtifactStore(),
): Promise<DirectApiFileMetadata[]> {
	if (!files?.length) return [];

	const publishedFiles: DirectApiFileMetadata[] = [];
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
	}

	return publishedFiles;
}
