#include "config.h"

int main(void)
{
    Sensor_Update();
    (void)Control_Read();
    return Monitor_Read();
}
