import { passwordProblem } from './index';

describe('management passwords', () => {
  it('needs 12 characters, varied, without the email or an obvious start', () => {
    expect(passwordProblem('short1!')).toMatch(/at least 12/);
    expect(passwordProblem('aaaaaaaaaaaaaaa')).toMatch(/different characters/);
    expect(passwordProblem('thandi-likes-tea', 'thandi@tsf.co.za')).toMatch(/email/);
    expect(passwordProblem('Password12345678')).toMatch(/too easy/);
    expect(passwordProblem('green gate at dawn')).toBeNull();
  });
});
