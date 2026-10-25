#ifndef DIFF_CONFIG_H
#define DIFF_CONFIG_H

#define SCALE 20

extern int g_rpm;
extern int g_limit;
extern int g_fault;

int Normalize(int value);
void Sensor_Update(void);
int Control_Read(void);
int Monitor_Read(void);
void Diagnostics(void);

#endif
