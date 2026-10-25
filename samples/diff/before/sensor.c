#include "config.h"

int g_rpm = 0;
int g_limit = 100;
int g_legacy = 1;

int Normalize(int value)
{
    return value;
}

void Sensor_Update(void)
{
    g_rpm = Normalize(SCALE);
}
