export class LobuApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly response: Response;

  constructor(response: Response, body: unknown) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Lobu API request failed with ${response.status}`;
    super(message);
    this.name = "LobuApiError";
    this.status = response.status;
    this.body = body;
    this.response = response;
  }
}
