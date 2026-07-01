import { IsEmail } from 'class-validator';

export class InviteTalentDto {
  @IsEmail()
  email: string;
}
