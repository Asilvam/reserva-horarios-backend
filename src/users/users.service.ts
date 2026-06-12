import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User } from './entities/user.entity';
import { Role } from '../auth/enums/role.enum';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  findByEmail(email: string) {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  findById(id: string) {
    return this.userModel.findById(id).exec();
  }

  async createAdminIfMissing(email: string, passwordHash: string) {
    const normalizedEmail = email.toLowerCase();
    const existing = await this.findByEmail(normalizedEmail);

    if (existing) {
      return existing;
    }

    const user = new this.userModel({
      email: normalizedEmail,
      passwordHash,
      role: Role.Admin,
      isActive: true,
    });

    return user.save();
  }

  async createGuardianUser(email: string, guardianId: string, passwordHash: string) {
    const normalizedEmail = email.toLowerCase();
    const existing = await this.findByEmail(normalizedEmail);

    if (existing) {
      throw new ConflictException('Ya existe un usuario con ese correo.');
    }

    const user = new this.userModel({
      email: normalizedEmail,
      passwordHash,
      role: Role.Guardian,
      guardianId: new Types.ObjectId(guardianId),
      isActive: true,
    });

    return user.save();
  }
}
