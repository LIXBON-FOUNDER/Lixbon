import { configure } from '@testing-library/react';

// Con la suite entera, vitest reparte los archivos entre tantos workers como núcleos hay y
// las pruebas de jsdom que montan listas grandes compiten por la CPU. Los topes por defecto
// (1 s en `waitFor`/`findBy…`, 5 s por prueba) se medían contra una máquina libre y producían
// fallos espurios (LXO-239, LXO-240). Los topes que ve cada prueba son una red de seguridad
// contra un cuelgue, no una medida de rendimiento: eso se comprueba con aserciones propias.
configure({ asyncUtilTimeout: 5000 });
