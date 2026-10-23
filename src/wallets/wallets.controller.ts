import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import { WalletsService } from './wallets.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  create(@Body() dto: CreateWalletDto) {
    return this.walletsService.create(dto);
  }

  @Get(':id')
  findById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.walletsService.findById(id);
  }

  
  @Get(':id/ledger')
  findLedger(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.walletsService.findLedger(
      id,
      page === undefined ? 1 : Number(page),
      limit === undefined ? 20 : Number(limit),
    );
  }

}