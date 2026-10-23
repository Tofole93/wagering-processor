export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} != ${right}`, 'CURRENCY_MISMATCH');
  }
}
