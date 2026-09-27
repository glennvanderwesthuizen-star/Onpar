import { canConfirmReceipt, DEFAULT_KIT, REORDER_ACTIONS } from './index';

describe('re-orders (section 6.7)', () => {
  it('follows Requested, Ordered, Assigned, Delivered', () => {
    expect(REORDER_ACTIONS.ordered.from).toEqual(['requested']);
    expect(REORDER_ACTIONS.delivered.from).toEqual(['assigned']);
  });
  it('lets the guard confirm receipt once on its way, never twice', () => {
    expect(canConfirmReceipt('delivered')).toBe(true);
    expect(canConfirmReceipt('requested')).toBe(false);
    expect(canConfirmReceipt('received')).toBe(false);
  });
  it('has sizes for uniform and asset numbers for equipment', () => {
    expect(DEFAULT_KIT.find((k) => k.name === 'Shirt')?.tracking).toBe('size');
    expect(DEFAULT_KIT.find((k) => k.name === 'Radio')?.tracking).toBe('asset');
  });
});
