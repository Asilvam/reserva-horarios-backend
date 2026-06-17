import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { Guardian } from './entities/guardian.entity';

@Injectable()
export class GuardiansService {
  constructor(
    @InjectModel(Guardian.name) private guardianModel: Model<Guardian>,
  ) {}

  async create(createGuardianDto: CreateGuardianDto): Promise<Guardian> {
    // 1. Verificar si el apoderado ya existe por su RUT
    const guardian = await this.guardianModel.findOne({ rut: createGuardianDto.rut });

    if (guardian) {
      // Validar que el teléfono no pertenezca a OTRO apoderado
      const existingGuardianByPhone = await this.guardianModel.findOne({
        phone: createGuardianDto.phone,
        _id: { $ne: guardian._id },
      });
      if (existingGuardianByPhone) {
        throw new ConflictException('El número de teléfono ya está registrado por otro apoderado.');
      }

      // Validar que los acompañantes no pertenezcan a OTRO apoderado
      const dependentRuts = (createGuardianDto.dependents ?? []).map((dependent) => dependent.rut);
      if (dependentRuts.length > 0) {
        const guardianWithDependentRut = await this.guardianModel
          .findOne({
            'dependents.rut': { $in: dependentRuts },
            _id: { $ne: guardian._id },
          })
          .select('dependents.rut')
          .lean();

        if (guardianWithDependentRut) {
          const existingDependentRut = guardianWithDependentRut.dependents
            .map((dependent) => dependent.rut)
            .find((rut) => dependentRuts.includes(rut));

          throw new ConflictException(
            `El acompañante con RUT ${existingDependentRut} ya está registrado con otro apoderado.`,
          );
        }
      }

      // Actualizar datos del apoderado
      guardian.name = createGuardianDto.name;
      guardian.phone = createGuardianDto.phone;
      guardian.email = createGuardianDto.email;
      if (createGuardianDto.address) guardian.address = createGuardianDto.address;
      if (createGuardianDto.commune) guardian.commune = createGuardianDto.commune;
      if (createGuardianDto.villa) guardian.villa = createGuardianDto.villa;
      if (createGuardianDto.emergencyName) guardian.emergencyName = createGuardianDto.emergencyName;
      if (createGuardianDto.emergencyPhone) guardian.emergencyPhone = createGuardianDto.emergencyPhone;
      guardian.dependents = createGuardianDto.dependents ?? [];
      guardian.acceptMarketing = createGuardianDto.acceptMarketing ?? false;
      guardian.acceptDataTerms = createGuardianDto.acceptDataTerms ?? false;

      return await guardian.save();
    }

    // 2. Si no existe, se procede al flujo de creación normal
    const existingGuardianByPhone = await this.guardianModel.findOne({ phone: createGuardianDto.phone });

    if (existingGuardianByPhone) {
      throw new ConflictException('El número de teléfono ya está registrado por otro apoderado.');
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
          `El acompañante con RUT ${existingDependentRut} ya está registrado con otro apoderado.`,
        );
      }
    }

    const newGuardian = new this.guardianModel(createGuardianDto);
    return await newGuardian.save();
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
