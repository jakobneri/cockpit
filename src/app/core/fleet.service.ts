import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { FleetResponse, NodeData, ServiceInfo } from '../models/types';

@Injectable({ providedIn: 'root' })
export class FleetService {
  constructor(private api: ApiService) {}

  getFleet(): Observable<FleetResponse> {
    return this.api.get<FleetResponse>('/api/fleet');
  }

  getNodeStats(hostname: string, range?: string): Observable<NodeData> {
    const q = range ? `?range=${range}` : '';
    return this.api.get<NodeData>(`/api/stats/${hostname}${q}`);
  }

  getServices(): Observable<ServiceInfo[]> {
    return this.api.get<ServiceInfo[]>('/api/pi/services');
  }

  serviceAction(name: string, action: string): Observable<unknown> {
    return this.api.post(`/api/pi/services/${name}/${action}`);
  }

  triggerUpdate(): Observable<unknown> {
    return this.api.post('/api/admin/update');
  }

  sendHeartbeat(): Observable<unknown> {
    return this.api.post('/api/active');
  }
}
