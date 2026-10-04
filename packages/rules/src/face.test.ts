import { faceSimilarity, faceVerdict } from './index';

describe('automatic face matching (D-36)', () => {
  it('reads the distance as match, uncertain or different', () => {
    expect(faceVerdict(0.29)).toBe('match');
    expect(faceVerdict(0.55)).toBe('uncertain');
    expect(faceVerdict(0.6)).toBe('no_match');
    expect(faceVerdict(0.67)).toBe('no_match');
  });
  it('says so when there was no face to compare', () => {
    expect(faceVerdict(null)).toBe('no_face');
    expect(faceVerdict(Number.NaN)).toBe('no_face');
    expect(faceSimilarity(null)).toBeNull();
  });
  it('shows an easy percentage', () => {
    expect(faceSimilarity(0.29)).toBe(71);
    expect(faceSimilarity(1.4)).toBe(0);
  });
});
