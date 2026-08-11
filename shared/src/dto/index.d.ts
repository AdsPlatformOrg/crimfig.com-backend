export declare class LoginDto {
    email: string;
    password: string;
    clientId?: string;
}
export declare class RegisterDto {
    email: string;
    password: string;
    phone?: string;
}
export declare class RefreshTokenDto {
    refreshToken: string;
}
export declare class MfaChallengeDto {
    code: string;
    deviceId?: string;
}
export declare class TokenPairResponseDto {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}
export declare class PaginationQueryDto {
    page?: number;
    limit?: number;
}
export declare class CreateOrganizationDto {
    name: string;
    slug?: string;
    description?: string;
}
//# sourceMappingURL=index.d.ts.map