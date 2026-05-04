import { Decimal } from 'decimal.js';

/**
 * Monetary arithmetic utility.
 * ALL money operations must go through this to avoid floating-point errors.
 * Uses Decimal.js with precision of 19 digits and 4 decimal places.
 */
export class Money {
  private constructor() {}

  static ZERO = new Decimal(0);

  static from(value: string | number | Decimal): Decimal {
    return new Decimal(value);
  }

  static add(a: Decimal | string, b: Decimal | string): Decimal {
    return new Decimal(a).plus(new Decimal(b));
  }

  static subtract(a: Decimal | string, b: Decimal | string): Decimal {
    return new Decimal(a).minus(new Decimal(b));
  }

  static multiply(a: Decimal | string, b: Decimal | string): Decimal {
    return new Decimal(a).times(new Decimal(b));
  }

  static divide(a: Decimal | string, b: Decimal | string): Decimal {
    return new Decimal(a).dividedBy(new Decimal(b));
  }

  static negate(value: Decimal | string): Decimal {
    return new Decimal(value).negated();
  }

  static isZero(value: Decimal | string): boolean {
    return new Decimal(value).isZero();
  }

  static isPositive(value: Decimal | string): boolean {
    return new Decimal(value).isPositive() && !new Decimal(value).isZero();
  }

  static isNegative(value: Decimal | string): boolean {
    return new Decimal(value).isNegative();
  }

  static sum(values: (Decimal | string)[]): Decimal {
    let result = new Decimal(0);
    for (const val of values) {
      result = result.plus(new Decimal(val));
    }
    return result;
  }

  static abs(value: Decimal | string): Decimal {
    return new Decimal(value).abs();
  }

  static min(a: Decimal | string, b: Decimal | string): Decimal {
    return Decimal.min(new Decimal(a), new Decimal(b));
  }

  static max(a: Decimal | string, b: Decimal | string): Decimal {
    return Decimal.max(new Decimal(a), new Decimal(b));
  }

  static greaterThan(a: Decimal | string, b: Decimal | string): boolean {
    return new Decimal(a).greaterThan(new Decimal(b));
  }

  static lessThan(a: Decimal | string, b: Decimal | string): boolean {
    return new Decimal(a).lessThan(new Decimal(b));
  }

  static equals(a: Decimal | string, b: Decimal | string): boolean {
    return new Decimal(a).equals(new Decimal(b));
  }

  /**
   * Distribute an amount across N parties proportionally, handling rounding remainders.
   * Ensures the sum of distributed amounts EXACTLY equals the input amount.
   */
  static distribute(
    total: Decimal | string,
    ratios: (Decimal | string)[],
  ): Decimal[] {
    const totalDec = new Decimal(total);
    const ratioDecs = ratios.map((r) => new Decimal(r));
    const ratioSum = ratioDecs.reduce((a, b) => a.plus(b), Money.ZERO);

    if (ratioSum.isZero()) {
      throw new Error('Cannot distribute with zero ratio sum');
    }

    // Calculate raw amounts
    const rawAmounts = ratioDecs.map((r) =>
      totalDec.times(r).dividedBy(ratioSum).toDecimalPlaces(4, Decimal.ROUND_DOWN),
    );

    // Calculate remainder and add to the largest share
    const distributed = rawAmounts.reduce((a, b) => a.plus(b), Money.ZERO);
    const remainder = totalDec.minus(distributed);

    if (!remainder.isZero()) {
      // Find the index of the largest ratio to absorb the remainder
      let maxIdx = 0;
      for (let i = 1; i < ratioDecs.length; i++) {
        if (ratioDecs[i].greaterThan(ratioDecs[maxIdx])) {
          maxIdx = i;
        }
      }
      rawAmounts[maxIdx] = rawAmounts[maxIdx].plus(remainder);
    }

    return rawAmounts;
  }

  /** Convert to string for Prisma Decimal fields */
  static toString(value: Decimal): string {
    return value.toFixed(4);
  }
}
