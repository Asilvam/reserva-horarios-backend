import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { Guardian } from './entities/guardian.entity';
import * as dns from 'dns/promises';

const DISPOSABLE_EMAIL_DOMAINS = [
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'guerrillamail.com',
  'sharklasers.com',
  'mailinator.com',
  'getairmail.com',
  'dispostable.com',
  'boun.cr',
  'trashmail.com',
];

const NAME_SPAM_REGEX = /([a-zA-ZáéíóúÁÉÍÓÚñÑüÜ])\1{3,}/i;

function validateNameCoherence(name: string): void {
  const trimmed = name.trim();
  const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'\-]+$/;
  if (!nameRegex.test(trimmed)) {
    throw new BadRequestException('El nombre contiene caracteres no permitidos. Solo se admiten letras, espacios, guiones y apóstrofes.');
  }

  if (NAME_SPAM_REGEX.test(trimmed)) {
    throw new BadRequestException('Por favor, evita repetir letras consecutivas de forma innecesaria en el nombre.');
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    throw new BadRequestException('Debe ingresar Nombre y Apellido (mínimo dos palabras).');
  }
  if (parts.some(p => p.length < 2)) {
    throw new BadRequestException('Cada palabra del nombre y apellido debe tener al menos 2 letras.');
  }
}

function validateDependentNameCoherence(name: string): void {
  const trimmed = name.trim();
  const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'\-]+$/;
  if (!nameRegex.test(trimmed)) {
    throw new BadRequestException('El nombre del acompañante contiene caracteres no permitidos. Solo se admiten letras.');
  }
  if (NAME_SPAM_REGEX.test(trimmed)) {
    throw new BadRequestException('Por favor, evita repetir letras consecutivas de forma innecesaria en el nombre del acompañante.');
  }
  if (trimmed.length < 2) {
    throw new BadRequestException('El nombre del acompañante debe tener al menos 2 letras.');
  }
}

async function validateEmailDomain(email: string): Promise<void> {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) {
    throw new BadRequestException('El formato del correo electrónico es inválido.');
  }

  if (DISPOSABLE_EMAIL_DOMAINS.includes(domain)) {
    throw new BadRequestException('No se permiten correos electrónicos temporales o desechables.');
  }

  try {
    const mxRecords = await dns.resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      throw new BadRequestException('El dominio de correo electrónico no tiene servidores de correo válidos (registros MX).');
    }
  } catch (error) {
    throw new BadRequestException('El dominio del correo electrónico no existe o no tiene configurado un servicio de mensajería válido.');
  }
}

@Injectable()
export class GuardiansService {
  constructor(
    @InjectModel(Guardian.name) private guardianModel: Model<Guardian>,
  ) {}

  async create(createGuardianDto: CreateGuardianDto): Promise<Guardian> {
    // Validar coherencia del nombre del apoderado
    validateNameCoherence(createGuardianDto.name);

    // Validar coherencia del correo
    await validateEmailDomain(createGuardianDto.email);

    // Validar coherencia de nombres de acompañantes
    if (createGuardianDto.dependents) {
      for (const dep of createGuardianDto.dependents) {
        validateDependentNameCoherence(dep.name);
      }
    }

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

  async findByRut(rut: string): Promise<Guardian | null> {
    const clean = rut.replace(/[^0-9kK]/g, '').toUpperCase();
    if (clean.length < 2) return null;
    const body = clean.slice(0, -1);
    const dv = clean.slice(-1);
    const formatted = `${body}-${dv}`;

    return this.guardianModel.findOne({
      $or: [
        { rut: clean },
        { rut: formatted },
      ],
    }).exec();
  }
}
