import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("app image build receipt workflow", () => {
	it("embeds immutable source identity and publishes the post-push registry digest receipt", () => {
		const workflow = readFileSync(
			path.resolve(
				__dirname,
				"../../../../../.github/workflows/build-images.yml",
			),
			"utf8",
		);
		expect(workflow).toContain("id: push-app");
		expect(workflow).toContain("APP_GIT_SHA=${{ github.sha }}");
		expect(workflow).toContain(
			"APP_BUILD_TIME=${{ needs.generate-tag.outputs.build_time }}",
		);
		expect(workflow).toContain("${{ steps.push-app.outputs.digest }}");
		expect(workflow).toContain("name: lobu-app-image-receipt");
		expect(workflow).toContain("actions/upload-artifact@v4");
		expect(workflow).not.toContain(
			"APP_DECLARED_IMAGE_DIGEST=${{ steps.push-app.outputs.digest }}",
		);
	});
});
