import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { from } from 'rxjs';
import { switchMap, map } from 'rxjs/operators';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) return true;

  return from(auth.tryRefresh()).pipe(
    map(ok => ok ? true : router.createUrlTree(['/login']))
  );
};

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = auth.currentUser();
  if (user?.role === 'admin') return true;
  return router.createUrlTree(['/']);
};
