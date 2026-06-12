import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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
}
