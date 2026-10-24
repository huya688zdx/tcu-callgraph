#include "shared.h"

int main(void)
{
    Sensor_Update();
    return (int)Control_Read();
}
