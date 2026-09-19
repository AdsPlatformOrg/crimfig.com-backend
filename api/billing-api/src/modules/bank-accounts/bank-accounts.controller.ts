import { Controller, Get, Post, Delete, Body, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BankAccountsService } from './bank-accounts.service';
import { IsString } from 'class-validator';
import { Public } from '@crimfig/shared';

export class AddBankAccountDto {
  @IsString()
  accountNumber: string;

  @IsString()
  bankCode: string;

  @IsString()
  bankName: string;
}

@ApiTags('Bank Accounts')
@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly bankAccountsService: BankAccountsService) {}

  @Public()
  @Get('banks')
  @ApiOperation({ summary: 'Get list of supported banks in Nigeria' })
  async listBanks() {
    const banks = await this.bankAccountsService.listBanks();
    return { status: 'success', data: banks };
  }

  @Public()
  @Get('resolve')
  @ApiOperation({ summary: 'Resolve account name from account number and bank code' })
  async resolveAccount(
    @Query('accountNumber') accountNumber: string,
    @Query('bankCode') bankCode: string,
  ) {
    const resolved = await this.bankAccountsService.resolveAccount(accountNumber, bankCode);
    return { status: 'success', data: resolved };
  }

  @Get()
  @ApiOperation({ summary: 'Get user saved bank accounts' })
  async getUserAccounts(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const accounts = await this.bankAccountsService.getUserBankAccounts(userId);
    return { status: 'success', data: accounts };
  }

  @Post()
  @ApiOperation({ summary: 'Save a verified bank account' })
  async addAccount(@Req() req: any, @Body() dto: AddBankAccountDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const account = await this.bankAccountsService.addBankAccount({
      userId,
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
      bankName: dto.bankName,
    });
    return { status: 'success', data: account };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a saved bank account' })
  async deleteAccount(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.bankAccountsService.deleteBankAccount(userId, id);
    return { status: 'success', data: result };
  }
}
