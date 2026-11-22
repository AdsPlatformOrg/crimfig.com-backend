import { IsString, IsUUID, IsIn, IsOptional, MinLength, MaxLength, IsBoolean } from 'class-validator';
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES } from './support-policy';
export class CreateSupportDto {
 @IsUUID() requestId!: string;
 @IsIn(SUPPORT_CATEGORIES) category!: string;
 @IsString() @MinLength(3) @MaxLength(200) subject!: string;
 @IsString() @MinLength(10) @MaxLength(10000) body!: string;
}
export class ReplySupportDto {
 @IsUUID() requestId!: string;
 @IsString() @MinLength(1) @MaxLength(10000) body!: string;
}
export class StaffReplySupportDto extends ReplySupportDto {
 @IsBoolean() internal!: boolean;
}
export class UpdateSupportDto {
 @IsOptional() @IsIn(SUPPORT_STATUSES) status?: string;
 @IsOptional() @IsIn(['low','medium','high','urgent']) priority?: string;
 @IsOptional() @IsUUID() assignedTo?: string;
 @IsOptional() @IsBoolean() unassign?: boolean;
}
export class SupportQueryDto {
 @IsOptional() @IsIn(SUPPORT_STATUSES) status?: string;
 @IsOptional() @IsIn(SUPPORT_CATEGORIES) category?: string;
 @IsOptional() @IsIn(['low','medium','high','urgent']) priority?: string;
 @IsOptional() @IsIn(['new','assigned','waiting','resolved']) queue?: string;
 @IsOptional() @IsString() @MaxLength(40) search?: string;
 @IsOptional() @IsString() @MaxLength(6) offset?: string;
}
