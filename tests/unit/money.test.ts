import { describe, expect, test, it } from 'bun:test';
import { Money } from '../../src/common/domain/money.js';

describe('Money', () => {
  test('normalizes valid decimal strings to fixed scale', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('adds and subtracts exactly without floating-point arithmetic', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).toJSON().amount).toBe('0.30');
    expect(b.subtract(a).toJSON().amount).toBe('0.10');
  });

  test('rejects negative input, scientific notation, and more than two decimal places', () => {
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1e3', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1.001', currency: 'BRL' })).toThrow();
  });

  test('rejects operations between different currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow('Currency mismatch');
  });

  test('is immutable and supports negative intermediate arithmetic results', () => {
    const one = Money.from({ amount: '1.00', currency: 'BRL' });
    const two = Money.from({ amount: '2.00', currency: 'BRL' });
    expect(one.subtract(two).toJSON().amount).toBe('-1.00');
    expect(one.toJSON().amount).toBe('1.00');
  });
  it('considera zero como não positivo', () => {
  const money = Money.from({
    amount: '0.00',
    currency: 'BRL',
  });

  expect(money.isPositive()).toBe(false);
  })
});
