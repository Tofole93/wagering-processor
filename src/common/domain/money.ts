import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Immutable money value object. Monetary values are never represented by JS number. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(props.amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with at most 2 fractional digits.');
    }
    if (!/^[A-Z]{3}$/.test(props.currency)) {
      throw new InvalidMoneyError('Currency must be a 3-letter uppercase ISO-4217 code.');
    }
    return new Money(new Decimal(props.amount).toDecimalPlaces(2), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static fromDecimal(value: Decimal, currency: string): Money {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError('Currency must be a 3-letter uppercase ISO-4217 code.');
    }
    return new Money(value.toDecimalPlaces(2), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean {return this.value.greaterThan(0);}
  isNegative(): boolean { return this.value.isNegative(); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string { return `${this.value.toFixed(2)} ${this.currency}`; }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
