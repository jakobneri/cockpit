import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { SpeedLog } from '../models/types';

@Injectable({ providedIn: 'root' })
export class SpeedService {
  constructor(private api: ApiService) {}

  getLogs(): Observable<SpeedLog[]> {
    return this.api.get<SpeedLog[]>('/api/speedlogs');
  }
}
