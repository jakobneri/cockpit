import { Routes } from '@angular/router';
import { authGuard, adminGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: '',
    loadComponent: () => import('./layout/layout.component').then(m => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./pages/fleet/fleet.component').then(m => m.FleetComponent)
      },
      {
        path: 'speed',
        loadComponent: () => import('./pages/speed/speed.component').then(m => m.SpeedComponent)
      },
      {
        path: 'users',
        loadComponent: () => import('./pages/users/users.component').then(m => m.UsersComponent),
        canActivate: [adminGuard]
      },
      {
        path: ':hostname',
        loadComponent: () => import('./pages/fleet/fleet.component').then(m => m.FleetComponent)
      }
    ]
  },
  { path: '**', redirectTo: '' }
];
