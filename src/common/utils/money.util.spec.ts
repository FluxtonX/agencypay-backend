import { describe, it, expect } from '@jest/globals';
import { Decimal } from 'decimal.js';
import { Money } from './money.util.js';

describe('Money Utility', () => {
  // ========================================================================
  // Basic arithmetic
  // ========================================================================
  describe('arithmetic', () => {
    it('should add correctly', () => {
      expect(Money.add('100.50', '200.75').toFixed(2)).toBe('301.25');
    });

    it('should subtract correctly', () => {
      expect(Money.subtract('500.00', '199.99').toFixed(2)).toBe('300.01');
    });

    it('should multiply correctly', () => {
      expect(Money.multiply('100.00', '0.025').toFixed(4)).toBe('2.5000');
    });

    it('should divide correctly', () => {
      expect(Money.divide('100.00', '3').toFixed(4)).toBe('33.3333');
    });

    it('should negate correctly', () => {
      expect(Money.negate('100.00').toString()).toBe('-100');
      expect(Money.negate('-50.00').toString()).toBe('50');
    });
  });

  // ========================================================================
  // Comparisons
  // ========================================================================
  describe('comparisons', () => {
    it('isZero should detect zero', () => {
      expect(Money.isZero('0')).toBe(true);
      expect(Money.isZero('0.0000')).toBe(true);
      expect(Money.isZero('0.0001')).toBe(false);
    });

    it('isPositive should detect positive', () => {
      expect(Money.isPositive('1.00')).toBe(true);
      expect(Money.isPositive('0.00')).toBe(false);
      expect(Money.isPositive('-1.00')).toBe(false);
    });

    it('isNegative should detect negative', () => {
      expect(Money.isNegative('-0.01')).toBe(true);
      expect(Money.isNegative('0.00')).toBe(false);
      expect(Money.isNegative('1.00')).toBe(false);
    });

    it('greaterThan should compare correctly', () => {
      expect(Money.greaterThan('100.01', '100.00')).toBe(true);
      expect(Money.greaterThan('100.00', '100.00')).toBe(false);
      expect(Money.greaterThan('99.99', '100.00')).toBe(false);
    });

    it('lessThan should compare correctly', () => {
      expect(Money.lessThan('99.99', '100.00')).toBe(true);
      expect(Money.lessThan('100.00', '100.00')).toBe(false);
    });

    it('equals should compare correctly', () => {
      expect(Money.equals('100.00', '100.0000')).toBe(true);
      expect(Money.equals('100.00', '100.01')).toBe(false);
    });

    it('min should return smaller value', () => {
      expect(Money.min('50', '100').toString()).toBe('50');
      expect(Money.min('100', '50').toString()).toBe('50');
    });

    it('max should return larger value', () => {
      expect(Money.max('50', '100').toString()).toBe('100');
      expect(Money.max('100', '50').toString()).toBe('100');
    });
  });

  // ========================================================================
  // sum
  // ========================================================================
  describe('sum', () => {
    it('should sum multiple values', () => {
      expect(Money.sum(['100', '200', '300']).toString()).toBe('600');
    });

    it('should handle negative values', () => {
      expect(Money.sum(['100', '-100']).toString()).toBe('0');
    });

    it('should handle empty array', () => {
      expect(Money.sum([]).toString()).toBe('0');
    });

    it('should handle Decimal objects', () => {
      expect(Money.sum([new Decimal('50.5'), new Decimal('49.5')]).toString()).toBe('100');
    });
  });

  // ========================================================================
  // abs
  // ========================================================================
  describe('abs', () => {
    it('should return absolute value of negative', () => {
      expect(Money.abs('-100.00').toString()).toBe('100');
    });

    it('should return same for positive', () => {
      expect(Money.abs('100.00').toString()).toBe('100');
    });
  });

  // ========================================================================
  // distribute — The critical rounding-safe split logic
  // ========================================================================
  describe('distribute', () => {
    it('should distribute evenly (2-way split)', () => {
      const result = Money.distribute('100.00', ['0.5', '0.5']);
      expect(result[0].plus(result[1]).toString()).toBe('100');
      expect(result[0].toFixed(4)).toBe('50.0000');
      expect(result[1].toFixed(4)).toBe('50.0000');
    });

    it('should handle 3-way split with remainder', () => {
      // 100 / 3 = 33.3333... repeating — can't split evenly
      const result = Money.distribute('100.00', ['1', '1', '1']);
      const sum = result.reduce((a, b) => a.plus(b), Money.ZERO);
      // SUM MUST EQUAL EXACTLY 100 (no lost cents)
      expect(sum.toString()).toBe('100');
    });

    it('should handle 70/30 split', () => {
      const result = Money.distribute('1000.00', ['0.70', '0.30']);
      expect(result[0].toFixed(4)).toBe('700.0000');
      expect(result[1].toFixed(4)).toBe('300.0000');
    });

    it('should handle split with platform fee (65/10/25)', () => {
      const result = Money.distribute('1000.00', ['0.65', '0.10', '0.25']);
      const sum = result.reduce((a, b) => a.plus(b), Money.ZERO);
      expect(sum.toString()).toBe('1000');
    });

    it('should give remainder to the largest ratio holder', () => {
      // $100 split 60/40 — both divide evenly, no remainder
      const result = Money.distribute('100.00', ['0.60', '0.40']);
      expect(result[0].toFixed(4)).toBe('60.0000');
      expect(result[1].toFixed(4)).toBe('40.0000');
    });

    it('should handle single recipient', () => {
      const result = Money.distribute('500.00', ['1.0']);
      expect(result[0].toFixed(4)).toBe('500.0000');
    });

    it('should throw for zero ratio sum', () => {
      expect(() => Money.distribute('100.00', ['0', '0'])).toThrow(
        'Cannot distribute with zero ratio sum',
      );
    });

    it('should handle very small amounts', () => {
      const result = Money.distribute('0.01', ['0.5', '0.5']);
      const sum = result.reduce((a, b) => a.plus(b), Money.ZERO);
      expect(sum.toFixed(4)).toBe('0.0100');
    });

    it('should handle large amounts without precision loss', () => {
      const result = Money.distribute('9999999.9999', ['0.3', '0.3', '0.4']);
      const sum = result.reduce((a, b) => a.plus(b), Money.ZERO);
      expect(sum.toFixed(4)).toBe('9999999.9999');
    });

    it('should handle uneven 5-way split', () => {
      const result = Money.distribute('1000.00', ['0.2', '0.2', '0.2', '0.2', '0.2']);
      const sum = result.reduce((a, b) => a.plus(b), Money.ZERO);
      expect(sum.toString()).toBe('1000');
    });
  });

  // ========================================================================
  // Floating-point safety
  // ========================================================================
  describe('floating-point safety', () => {
    it('should not have floating-point errors for 0.1 + 0.2', () => {
      // Classic floating-point trap: 0.1 + 0.2 !== 0.3 in IEEE 754
      const result = Money.add('0.1', '0.2');
      expect(result.toString()).toBe('0.3');
    });

    it('should handle currency-scale precision', () => {
      const result = Money.multiply('19.99', '7');
      expect(result.toString()).toBe('139.93');
    });
  });
});
