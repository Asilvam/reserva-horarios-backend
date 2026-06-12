import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { Guardian } from './entities/guardian.entity';
import { UsersService } from '../users/users.service';
import { generateGuardianPassword } from '../common/security/password-generator';
import { MailService } from '../mail/mail.service';

@Injectable()
export class GuardiansService {
  constructor(
    @InjectModel(Guardian.name) private guardianModel: Model<Guardian>,
    private usersService: UsersService,
    private mailService: MailService,
  ) {}

  async create(createGuardianDto: CreateGuardianDto): Promise<Guardian> {
    // Verificar si el apoderado ya existe por su RUT
    const existingGuardian = await this.guardianModel.findOne({ rut: createGuardianDto.rut });

    if (existingGuardian) {
      throw new ConflictException('A guardian with this RUT already exists.');
    }

    const dependentRuts = (createGuardianDto.dependents ?? []).map((dependent) => dependent.rut);

    if (dependentRuts.length > 0) {
      const guardianWithDependentRut = await this.guardianModel
        .findOne({ 'dependents.rut': { $in: dependentRuts } })
        .select('dependents.rut')
        .lean();

      if (guardianWithDependentRut) {
        const existingDependentRut = guardianWithDependentRut.dependents
          .map((dependent) => dependent.rut)
          .find((rut) => dependentRuts.includes(rut));

        throw new ConflictException(
          `Dependent with RUT ${existingDependentRut} already belongs to another guardian.`,
        );
      }
    }

    const tempPassword = generateGuardianPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const newGuardian = new this.guardianModel(createGuardianDto);
    const savedGuardian = await newGuardian.save();

    try {
      await this.usersService.createGuardianUser(savedGuardian.email, savedGuardian.id, passwordHash);
      await this.mailService.sendGuardianCredentials(savedGuardian.email, tempPassword);
    } catch (error) {
      await this.guardianModel.findByIdAndDelete(savedGuardian.id);
      throw error;
    }

    return savedGuardian;
  }

  async findAll(): Promise<Guardian[]> {
    return await this.guardianModel.find().exec();
  }

  async findById(id: string): Promise<Guardian> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Id de guardian invalido');
    }

    const guardian = await this.guardianModel.findById(id).exec();
    if (!guardian) {
      throw new NotFoundException(`Guardian with ID ${id} not found.`);
    }
    return guardian;
  }
}
