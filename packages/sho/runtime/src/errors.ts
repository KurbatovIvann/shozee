export class BundleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

export class ModelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

export class InputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}
