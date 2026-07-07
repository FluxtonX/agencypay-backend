import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CreateConnectionRequestDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  type: string;
}
