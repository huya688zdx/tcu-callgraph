#ifndef DIFF_CONFIG_H
#define DIFF_CONFIG_H

#define SCALE 10

extern int g_rpm;
extern int g_limit;
extern int g_legacy;

int Normalize(int value);
void Sensor_Update(void);
int Control_Read(void);
int Monitor_Read(void);
int Supervisor_Read(void);
void Legacy_Log(void);

#endif
