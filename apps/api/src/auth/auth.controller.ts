import { Body, Controller, Get, HttpCode, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { ROLE_LABELS, Role, PERMISSIONS, can, Permission } from '@onpar/rules';
import { CurrentUser, UserAuthGuard, UserPrincipal } from '../common/auth';
import { hashSecret, verifySecret } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const LoginBody = z.object({
  email: z.string().trim().email('Enter your email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

// Verifying against a real hash when the email is unknown keeps response times alike.
let dummyHash: Promise<string> | undefined;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const { email, password } = parseBody(LoginBody, body);
    const [u] = await this.db.query<{
      id: string;
      company_id: string;
      password_hash: string;
      role: Role;
      active: boolean;
      full_name: string;
    }>('SELECT * FROM auth_user_by_email($1)', [email]);
    const ok = await verifySecret(u?.password_hash ?? (await (dummyHash ??= hashSecret('not-a-password'))), password);
    if (!u || !ok || !u.active) {
      if (u) {
        await this.db.withTenant(u.company_id, (tx) =>
          this.audit.record(tx, {
            actorType: 'user',
            actorId: u.id,
            actorLabel: u.full_name,
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: u.id,
          }),
        );
      }
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    await this.db.withTenant(u.company_id, (tx) =>
      this.audit.record(tx, {
        actorType: 'user',
        actorId: u.id,
        actorLabel: u.full_name,
        action: 'auth.login',
        entityType: 'user',
        entityId: u.id,
      }),
    );
    const token = await this.jwt.signAsync({ sub: u.id, cid: u.company_id, typ: 'user' }, { expiresIn: '12h' });
    return { token };
  }

  @Get('me')
  @UseGuards(UserAuthGuard)
  async me(@CurrentUser() user: UserPrincipal) {
    const company = await this.db.withTenant(user.companyId, async (tx) => {
      return (await tx.query('SELECT id, name FROM companies')).rows[0];
    });
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(user.role, p));
    return {
      id: user.userId,
      name: user.name,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      company,
      siteIds: user.siteIds,
      permissions,
    };
  }
}
