import { Role } from '../enums/role.enum';

export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
  guardianId?: string;
}
